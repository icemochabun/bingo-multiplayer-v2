const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── QR code endpoint ──────────────────────────────────────────────────────────
app.get('/api/qr', async (req, res) => {
  const data = req.query.data;
  if (!data) return res.status(400).end();
  try {
    const png = await QRCode.toBuffer(data, {
      width: 220,
      margin: 2,
      color: { dark: '#1e293b', light: '#f1f5f9' }
    });
    res.set('Content-Type', 'image/png').send(png);
  } catch {
    res.status(500).end();
  }
});

// ─── Game state ────────────────────────────────────────────────────────────────
const rooms = {}; // roomId → Room

function generateBingoCard() {
  // Standard BINGO: B(1-15), I(16-30), N(31-45), G(46-60), O(61-75)
  const ranges = [
    [1, 15],
    [16, 30],
    [31, 45],
    [46, 60],
    [61, 75]
  ];
  const card = [];
  for (let col = 0; col < 5; col++) {
    const [min, max] = ranges[col];
    const pool = [];
    for (let n = min; n <= max; n++) pool.push(n);
    const picked = [];
    for (let i = 0; i < 5; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    card.push(picked);
  }
  // card[col][row] — convert to card[row][col] for display
  const grid = [];
  for (let row = 0; row < 5; row++) {
    const r = [];
    for (let col = 0; col < 5; col++) {
      r.push(card[col][row]);
    }
    grid.push(r);
  }
  // Free space
  grid[2][2] = 'FREE';
  return grid;
}

function generateBallPool() {
  const pool = [];
  for (let n = 1; n <= 75; n++) pool.push(n);
  return pool;
}

function checkBingo(grid, called) {
  const calledSet = new Set(called);
  const hit = (val) => val === 'FREE' || calledSet.has(val);

  // Rows
  for (let r = 0; r < 5; r++) {
    if (grid[r].every(hit)) return true;
  }
  // Columns
  for (let c = 0; c < 5; c++) {
    if (grid.map(row => row[c]).every(hit)) return true;
  }
  // Diagonals
  if ([0,1,2,3,4].every(i => hit(grid[i][i]))) return true;
  if ([0,1,2,3,4].every(i => hit(grid[i][4-i]))) return true;

  return false;
}

function createRoom(hostId, hostName) {
  const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
  rooms[roomId] = {
    id: roomId,
    hostId,
    players: {},       // socketId → { name, card, markedNumbers }
    calledNumbers: [],
    ballPool: generateBallPool(),
    started: false,
    winner: null,
    callInterval: null
  };
  return roomId;
}

function roomPublicState(room) {
  return {
    id: room.id,
    started: room.started,
    winner: room.winner,
    calledNumbers: room.calledNumbers,
    players: Object.values(room.players).map(p => ({
      id: p.id,
      name: p.name
    }))
  };
}

// ─── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // Create a new room
  socket.on('createRoom', ({ name }) => {
    const roomId = createRoom(socket.id, name);
    const room = rooms[roomId];
    const card = generateBingoCard();
    room.players[socket.id] = { id: socket.id, name, card, markedNumbers: [] };
    socket.join(roomId);
    socket.emit('roomCreated', { roomId, card });
    io.to(roomId).emit('roomState', roomPublicState(room));
    console.log(`[createRoom] ${name} created room ${roomId}`);
  });

  // Join an existing room
  socket.on('joinRoom', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }
    if (room.started) {
      socket.emit('error', { message: 'Game already started.' });
      return;
    }
    const card = generateBingoCard();
    room.players[socket.id] = { id: socket.id, name, card, markedNumbers: [] };
    socket.join(roomId);
    socket.emit('roomJoined', { roomId, card, calledNumbers: room.calledNumbers });
    io.to(roomId).emit('roomState', roomPublicState(room));
    console.log(`[joinRoom] ${name} joined room ${roomId}`);
  });

  // Host starts the game
  socket.on('startGame', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    if (Object.keys(room.players).length < 1) {
      socket.emit('error', { message: 'Need at least 1 player to start.' });
      return;
    }
    room.started = true;
    io.to(roomId).emit('gameStarted');
    io.to(roomId).emit('roomState', roomPublicState(room));

    // Call a number every 5 seconds
    room.callInterval = setInterval(() => {
      if (!rooms[roomId] || room.ballPool.length === 0) {
        clearInterval(room.callInterval);
        return;
      }
      const idx = Math.floor(Math.random() * room.ballPool.length);
      const number = room.ballPool.splice(idx, 1)[0];
      room.calledNumbers.push(number);
      const letter = 'BINGO'[Math.ceil(number / 15) - 1];
      io.to(roomId).emit('numberCalled', { number, letter, calledNumbers: room.calledNumbers });
      console.log(`[call] Room ${roomId}: ${letter}${number}`);
    }, 5000);
  });

  // Player marks a number (client-side validation support)
  socket.on('markNumber', ({ roomId, number }) => {
    const room = rooms[roomId];
    if (!room || !room.started) return;
    const player = room.players[socket.id];
    if (!player) return;
    if (!player.markedNumbers.includes(number)) {
      player.markedNumbers.push(number);
    }
  });

  // Player claims BINGO
  socket.on('claimBingo', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.started || room.winner) return;
    const player = room.players[socket.id];
    if (!player) return;

    if (checkBingo(player.card, room.calledNumbers)) {
      room.winner = player.name;
      clearInterval(room.callInterval);
      room.callInterval = null;
      io.to(roomId).emit('bingoWon', { winner: player.name, card: player.card, calledNumbers: room.calledNumbers });
      io.to(roomId).emit('roomState', roomPublicState(room));
      console.log(`[bingo] ${player.name} won in room ${roomId}`);
    } else {
      socket.emit('invalidBingo', { message: 'Not a valid bingo yet!' });
    }
  });

  // Restart game (host only)
  socket.on('restartGame', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    clearInterval(room.callInterval);

    room.calledNumbers = [];
    room.ballPool = generateBallPool();
    room.started = false;
    room.winner = null;
    room.callInterval = null;

    // Give each player a new card
    for (const pid of Object.keys(room.players)) {
      const card = generateBingoCard();
      room.players[pid].card = card;
      room.players[pid].markedNumbers = [];
      io.to(pid).emit('newCard', { card });
    }

    io.to(roomId).emit('gameRestarted');
    io.to(roomId).emit('roomState', roomPublicState(room));
    console.log(`[restart] Room ${roomId}`);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    for (const roomId of Object.keys(rooms)) {
      const room = rooms[roomId];
      if (!room.players[socket.id]) continue;

      delete room.players[socket.id];

      if (Object.keys(room.players).length === 0) {
        clearInterval(room.callInterval);
        delete rooms[roomId];
        console.log(`[cleanup] Room ${roomId} deleted`);
      } else {
        // Transfer host if needed
        if (room.hostId === socket.id) {
          room.hostId = Object.keys(room.players)[0];
          io.to(room.hostId).emit('youAreHost');
        }
        io.to(roomId).emit('roomState', roomPublicState(room));
      }
    }
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Bingo server running on port ${PORT}`);
});
