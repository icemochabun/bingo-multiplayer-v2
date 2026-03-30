/* ── Socket ── */
const socket = io();

/* ── State ── */
let state = {
  roomId: null,
  isHost: false,
  card: null,          // grid[row][col]
  calledNumbers: [],
  gameOver: false
};

/* ── DOM helpers ── */
const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');
const showScreen = name => {
  ['lobby', 'waitingRoom', 'gameScreen'].forEach(s => {
    document.getElementById(s).classList.toggle('hidden', s !== name);
  });
};

/* ── Letter for a number ── */
function letterOf(n) {
  if (n <= 15) return 'b';
  if (n <= 30) return 'i';
  if (n <= 45) return 'n';
  if (n <= 60) return 'g';
  return 'o';
}

/* ── Render bingo card ── */
function renderCard(card, calledNumbers) {
  const container = $('bingoCard');
  container.innerHTML = '';
  const headers = ['B', 'I', 'N', 'G', 'O'];

  // Header row
  headers.forEach(h => {
    const div = document.createElement('div');
    div.className = 'bingo-header';
    div.textContent = h;
    container.appendChild(div);
  });

  // Cells: card[row][col]
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const val = card[row][col];
      const div = document.createElement('div');
      if (val === 'FREE') {
        div.className = 'bingo-cell free';
        div.textContent = 'FREE';
      } else {
        const isMarked = calledNumbers.includes(val);
        div.className = 'bingo-cell' + (isMarked ? ' marked' : '');
        div.textContent = val;
        div.dataset.value = val;
        div.addEventListener('click', () => onCellClick(val, div));
      }
      container.appendChild(div);
    }
  }
}

/* ── Manual cell click ── */
function onCellClick(val, div) {
  if (state.gameOver) return;
  if (!state.calledNumbers.includes(val)) return; // only mark called numbers
  div.classList.add('marked');
  socket.emit('markNumber', { roomId: state.roomId, number: val });
}

/* ── Render called balls ── */
function renderBalls(calledNumbers) {
  const container = $('calledBalls');
  container.innerHTML = '';
  calledNumbers.slice().reverse().forEach(n => {
    const span = document.createElement('span');
    const l = letterOf(n);
    span.className = `ball ${l}`;
    span.textContent = `${l.toUpperCase()}${n}`;
    container.appendChild(span);
  });
}

/* ── Update player list ── */
function renderPlayers(players, hostId, containerId) {
  const container = $(containerId);
  container.innerHTML = '';
  players.forEach(p => {
    const div = document.createElement('div');
    div.className = 'player-item';
    const isHost = p.id === hostId;
    div.innerHTML = `${isHost ? '<span class="crown">👑</span>' : ''}<span>${escHtml(p.name)}</span>`;
    container.appendChild(div);
  });
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ── Lobby ── */
$('createBtn').addEventListener('click', () => {
  const name = $('playerName').value.trim();
  if (!name) { showError('Enter your name first.'); return; }
  socket.emit('createRoom', { name });
});

$('joinBtn').addEventListener('click', () => {
  const name = $('playerName').value.trim();
  const code = $('roomCodeInput').value.trim().toUpperCase();
  if (!name) { showError('Enter your name first.'); return; }
  if (!code) { showError('Enter a room code.'); return; }
  socket.emit('joinRoom', { roomId: code, name });
});

$('roomCodeInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('joinBtn').click();
});
$('playerName').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('createBtn').click();
});

function showError(msg) {
  $('lobbyError').textContent = msg;
  setTimeout(() => { $('lobbyError').textContent = ''; }, 3000);
}

/* ── Waiting room ── */
$('startBtn').addEventListener('click', () => {
  socket.emit('startGame', { roomId: state.roomId });
});

$('copyCodeBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(state.roomId).catch(() => {});
  $('copyCodeBtn').textContent = 'Copied!';
  setTimeout(() => { $('copyCodeBtn').textContent = 'Copy'; }, 1500);
});

/* ── Game ── */
$('claimBingoBtn').addEventListener('click', () => {
  if (state.gameOver) return;
  socket.emit('claimBingo', { roomId: state.roomId });
});

$('restartBtn').addEventListener('click', () => {
  socket.emit('restartGame', { roomId: state.roomId });
});

$('winCloseBtn').addEventListener('click', () => {
  hide('winModal');
});

/* ── Socket events ── */
socket.on('roomCreated', ({ roomId, card }) => {
  state.roomId = roomId;
  state.isHost = true;
  state.card = card;
  $('displayRoomCode').textContent = roomId;
  show('startBtn');
  hide('waitingMsg');
  showScreen('waitingRoom');
});

socket.on('roomJoined', ({ roomId, card, calledNumbers }) => {
  state.roomId = roomId;
  state.isHost = false;
  state.card = card;
  state.calledNumbers = calledNumbers || [];
  $('displayRoomCode').textContent = roomId;
  hide('startBtn');
  show('waitingMsg');
  showScreen('waitingRoom');
});

socket.on('roomState', ({ id, players, started, winner, calledNumbers }) => {
  // Update waiting room player list
  renderPlayers(players, null, 'playerList');
  // Update game player list
  renderPlayers(players, null, 'gamePlayers');
});

socket.on('gameStarted', () => {
  state.gameOver = false;
  state.calledNumbers = [];
  $('gameRoomCode').textContent = state.roomId;
  renderCard(state.card, []);
  renderBalls([]);
  $('lastCalled').textContent = '—';
  $('claimBingoBtn').disabled = false;
  if (state.isHost) show('restartBtn'); else hide('restartBtn');
  showScreen('gameScreen');
});

socket.on('numberCalled', ({ number, letter, calledNumbers }) => {
  state.calledNumbers = calledNumbers;
  $('lastCalled').textContent = `${letter}${number}`;

  // Mark matching cell
  const cell = document.querySelector(`.bingo-cell[data-value="${number}"]`);
  if (cell) {
    cell.classList.add('marked', 'new-call');
    cell.addEventListener('animationend', () => cell.classList.remove('new-call'), { once: true });
  }

  renderBalls(calledNumbers);
});

socket.on('bingoWon', ({ winner, calledNumbers }) => {
  state.gameOver = true;
  $('claimBingoBtn').disabled = true;
  $('winTitle').textContent = `${escHtml(winner)} wins!`;
  $('winSubtitle').textContent = `Bingo confirmed with ${calledNumbers.length} numbers called.`;
  show('winModal');
});

socket.on('invalidBingo', ({ message }) => {
  const btn = $('claimBingoBtn');
  btn.textContent = 'Not yet!';
  btn.style.background = 'var(--danger)';
  setTimeout(() => {
    btn.textContent = 'BINGO!';
    btn.style.background = '';
  }, 1500);
});

socket.on('gameRestarted', () => {
  state.gameOver = false;
  state.calledNumbers = [];
  $('lastCalled').textContent = '—';
  $('claimBingoBtn').disabled = false;
  hide('winModal');
});

socket.on('newCard', ({ card }) => {
  state.card = card;
  renderCard(card, []);
  renderBalls([]);
});

socket.on('youAreHost', () => {
  state.isHost = true;
  show('restartBtn');
});

socket.on('error', ({ message }) => {
  showError(message);
});

socket.on('connect_error', () => {
  showError('Connection error. Please refresh.');
});
