# phaser3-mp-game-starter

Phaser 3 + Node.js(Express) + Socket.io + SQLite 기반 멀티플레이 웹 게임 스타터. 로그인과 유저별 진행도 저장까지 포함한 올인원 템플릿.

## Requirements
- Node.js >= 18

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the development server:
   ```bash
   npm start
   ```
3. Open the app in your browser at <http://localhost:3000>.

## Features
- Express backend with SQLite (better-sqlite3) for user accounts, profiles, and recent game results
- Bcrypt password hashing and JWT cookie authentication with register/login/logout endpoints
- Socket.io real-time channel secured by the same JWT cookie
- Phaser 3 front-end that connects to the multiplayer server, shows simple UI for auth/profile, and syncs player position/HP across peers
- Game end reporting to persist basic score/duration state per player
