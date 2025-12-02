const express = require('express');
const http = require('http');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const DB_PATH = process.env.DB_PATH || 'game.db';
const COOKIE_NAME = 'auth_token';
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
};

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS profiles (
      user_id INTEGER PRIMARY KEY,
      display_name TEXT,
      bio TEXT,
      hp INTEGER DEFAULT 100,
      last_login DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS game_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      score INTEGER,
      duration INTEGER,
      hp_remaining INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
}

initDb();

function createToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

app.post('/api/register', async (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
    const userId = result.lastInsertRowid;
    db.prepare('INSERT INTO profiles (user_id, display_name, hp) VALUES (?, ?, ?)').run(userId, displayName || username, 100);
    const token = createToken({ id: userId, username });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
    return res.json({ id: userId, username, displayName: displayName || username });
  } catch (err) {
    return res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(400).json({ error: 'Invalid credentials' });

  db.prepare('UPDATE profiles SET last_login = CURRENT_TIMESTAMP WHERE user_id = ?').run(user.id);
  const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(user.id);
  const token = createToken(user);
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
  return res.json({ id: user.id, username: user.username, profile });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
  return res.json({ success: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(req.user.id);
  const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.user.id);
  return res.json({ user, profile });
});

app.get('/api/profile', authMiddleware, (req, res) => {
  const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.user.id);
  return res.json({ profile });
});

app.post('/api/profile', authMiddleware, (req, res) => {
  const { displayName, bio } = req.body || {};
  db.prepare('UPDATE profiles SET display_name = COALESCE(?, display_name), bio = COALESCE(?, bio) WHERE user_id = ?').run(displayName, bio, req.user.id);
  const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.user.id);
  return res.json({ profile });
});

app.post('/api/game-end', authMiddleware, (req, res) => {
  const { score = 0, duration = 0, hp = 0 } = req.body || {};
  db.prepare('INSERT INTO game_results (user_id, score, duration, hp_remaining) VALUES (?, ?, ?, ?)').run(req.user.id, score, duration, hp);
  db.prepare('UPDATE profiles SET hp = ?, last_login = CURRENT_TIMESTAMP WHERE user_id = ?').run(hp, req.user.id);
  return res.json({ success: true });
});

app.get('/api/results', authMiddleware, (req, res) => {
  const results = db.prepare('SELECT * FROM game_results WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(req.user.id);
  return res.json({ results });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function parseCookie(cookieHeader) {
  return (cookieHeader || '').split(';').reduce((acc, item) => {
    const [key, ...value] = item.trim().split('=');
    if (key) acc[key] = decodeURIComponent(value.join('='));
    return acc;
  }, {});
}

const players = new Map();

io.use((socket, next) => {
  const cookies = parseCookie(socket.handshake.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return next(new Error('Unauthorized'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const playerState = {
    id: socket.id,
    userId: socket.user.id,
    username: socket.user.username,
    x: 100,
    y: 100,
    hp: 100,
  };

  players.set(socket.id, playerState);
  socket.emit('currentPlayers', Array.from(players.values()));
  socket.broadcast.emit('playerJoined', playerState);

  socket.on('playerState', (state) => {
    const current = players.get(socket.id);
    if (!current) return;
    players.set(socket.id, { ...current, ...state });
    io.emit('playerStateUpdate', { id: socket.id, ...players.get(socket.id) });
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    socket.broadcast.emit('playerLeft', { id: socket.id });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
