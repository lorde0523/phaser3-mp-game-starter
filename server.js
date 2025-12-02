const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Constants
const SALT_ROUNDS = 10;
const GAME_WIDTH = 800;
const GAME_HEIGHT = 600;

// Parse JSON bodies
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite database
const db = new Database('game.db');

// Create users table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  )
`);

// In-memory player state: { id, x, y, hp }
const players = {};

// Login endpoint
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password required' });
  }

  try {
    // Check if user exists
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (user) {
      // Verify password using bcrypt
      const match = await bcrypt.compare(password, user.password);
      if (match) {
        return res.json({ success: true, userId: user.id, message: 'Login successful' });
      } else {
        return res.status(401).json({ success: false, message: 'Invalid password' });
      }
    } else {
      // Register new user with hashed password
      const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
      const result = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hashedPassword);
      return res.json({ success: true, userId: result.lastInsertRowid, message: 'User registered and logged in' });
    }
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Initialize new player
  players[socket.id] = {
    id: socket.id,
    x: 400,
    y: 300,
    hp: 100
  };

  // Send current players to the new player
  socket.emit('currentPlayers', players);

  // Notify others about the new player
  socket.broadcast.emit('newPlayer', players[socket.id]);

  // Handle player movement
  socket.on('playerMovement', (movementData) => {
    if (players[socket.id]) {
      // Validate movement data
      if (typeof movementData.x !== 'number' || typeof movementData.y !== 'number') {
        return;
      }

      // Clamp coordinates to game bounds
      const x = Math.max(0, Math.min(GAME_WIDTH, movementData.x));
      const y = Math.max(0, Math.min(GAME_HEIGHT, movementData.y));

      players[socket.id].x = x;
      players[socket.id].y = y;

      // Broadcast to all other players
      socket.broadcast.emit('playerMoved', players[socket.id]);
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
