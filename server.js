const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Table } = require('./engine/table');

// Unpaid results from earlier games (euro cents by lowercase name); see carryover.json.
const CARRYOVER = Object.fromEntries(
  Object.entries(require('./carryover.json'))
    .filter(([name]) => !name.startsWith('_'))
    .map(([name, cents]) => [name.trim().toLowerCase(), cents]),
);

const PORT = process.env.PORT || process.argv[2] || 3000;
// No turn clock: players take as long as they like. Only someone who has lost their
// connection gets auto-checked/folded, so one dropped phone can't freeze the table.
const DISCONNECTED_TURN_MS = 60_000;
const NEXT_HAND_MS = 5_000;      // pause to show results between hands
const EMPTY_ROOM_MS = 30 * 60_000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map(); // code -> room

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, they look like 1 and 0
  let code;
  do {
    code = Array.from({ length: 5 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const cleanName = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 16);

// House rules are fixed: €5 buy-ins, €0.05 / €0.10 blinds (see engine/table.js).
function createRoom() {
  const room = {
    code: makeCode(),
    table: new Table({ carryover: CARRYOVER }),
    hostId: null,
    started: false,
    ending: false,       // host pressed End game during a hand
    ended: false,
    settlement: null,    // who pays whom, once the game has ended
    tokens: new Map(),   // secret token -> player id (lets you rejoin after a refresh)
    sockets: new Map(),  // player id -> socket
    turnTimer: null,
    turnKey: null,
    nextHandTimer: null,
    emptySince: null,
  };
  rooms.set(room.code, room);
  return room;
}

function broadcast(room) {
  for (const [playerId, socket] of room.sockets) {
    socket.emit('state', {
      code: room.code,
      you: playerId,
      hostId: room.hostId,
      started: room.started,
      ending: room.ending,
      ended: room.ended,
      settlement: room.settlement,
      table: room.table.view(playerId),
    });
  }
}

// Called after every change: keeps timers in step with the table, then sends state.
function sync(room) {
  const t = room.table;

  // Changes when a new turn starts or the player to act drops/reconnects.
  const actor = t.handActive ? t.seats[t.turn] : null;
  const key = actor ? `${t.handNumber}:${t.phase}:${t.turn}:${actor.connected}` : null;
  if (key !== room.turnKey) {
    room.turnKey = key;
    clearTimeout(room.turnTimer);
    if (actor && !actor.connected) {
      const p = actor;
      room.turnTimer = setTimeout(() => {
        const opts = t.options(p.id);
        if (!opts) return;
        try {
          t.act(p.id, opts.canCheck ? 'check' : 'fold');
          if (!opts.canCheck) p.sittingOut = true; // stop dealing to someone who walked away
        } catch (e) {
          console.error(e);
        }
        sync(room);
      }, DISCONNECTED_TURN_MS);
    }
  }

  if (room.ending && !t.handActive) endGame(room);

  if (room.started && !room.ended && !t.handActive && !room.nextHandTimer && t.eligiblePlayers().length >= 2) {
    const delay = t.phase === 'handover' ? NEXT_HAND_MS : 1500;
    room.nextHandTimer = setTimeout(() => {
      room.nextHandTimer = null;
      if (!t.handActive && !room.ended && !room.ending) t.startHand();
      sync(room);
    }, delay);
  }

  broadcast(room);
}

function endGame(room) {
  room.ending = false;
  room.ended = true;
  clearTimeout(room.nextHandTimer);
  room.nextHandTimer = null;
  room.settlement = room.table.settlement();
}

function seatPlayer(socket, room, { name, token }) {
  const t = room.table;
  let playerId = room.tokens.get(token);
  let p = playerId && t.getPlayer(playerId);

  if (p) {
    // Rejoining (page refresh / dropped connection).
    const old = room.sockets.get(p.id);
    if (old && old.id !== socket.id) old.emit('kicked', 'You joined from another tab');
    p.connected = true;
  } else {
    if (!name) throw new Error('Enter a name');
    if (room.ended) throw new Error('This game has ended');
    playerId = crypto.randomUUID();
    p = t.addPlayer({ id: playerId, name });
    room.tokens.set(token, playerId);
  }
  if (!room.hostId || !t.getPlayer(room.hostId)) room.hostId = p.id;
  room.sockets.set(p.id, socket);
  room.emptySince = null;
  socket.data = { code: room.code, playerId: p.id };
  socket.join(room.code);
  sync(room);
}

function leave(socket) {
  const { code, playerId } = socket.data || {};
  const room = rooms.get(code);
  if (!room) return;
  const t = room.table;
  const p = t.getPlayer(playerId);
  socket.data = {};
  socket.leave(code);
  room.sockets.delete(playerId);
  for (const [tok, id] of room.tokens) if (id === playerId) room.tokens.delete(tok);
  if (p) t.removePlayer(playerId);
  if (room.hostId === playerId) room.hostId = t.players.find((o) => !o.leaving)?.id || null;
  if (room.sockets.size === 0) room.emptySince = Date.now();
  sync(room);
}

io.on('connection', (socket) => {
  // Every handler replies via callback: { ok: true } or { error: 'message' }.
  const handle = (event, fn) =>
    socket.on(event, (payload = {}, reply = () => {}) => {
      try {
        fn(payload);
        reply({ ok: true, code: socket.data?.code });
      } catch (e) {
        reply({ error: e.message });
      }
    });

  const current = () => {
    const room = rooms.get(socket.data?.code);
    const p = room && room.table.getPlayer(socket.data.playerId);
    if (!p) throw new Error('You are not at a table');
    return { room, t: room.table, p };
  };

  handle('create', ({ name, token }) => {
    name = cleanName(name);
    if (!name) throw new Error('Enter a name');
    if (socket.data?.code) leave(socket);
    seatPlayer(socket, createRoom(), { name, token: String(token) });
  });

  handle('join', ({ code, name, token }) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) throw new Error('No table with that code');
    if (socket.data?.code && socket.data.code !== room.code) leave(socket);
    seatPlayer(socket, room, { name: cleanName(name), token: String(token) });
  });

  handle('start', () => {
    const { room, t, p } = current();
    if (p.id !== room.hostId) throw new Error('Only the host can start the game');
    if (room.ended) throw new Error('This game has ended');
    if (t.eligiblePlayers().length < 2) throw new Error('Need at least 2 players');
    room.started = true;
    sync(room);
  });

  handle('action', ({ type, amount }) => {
    const { room, t, p } = current();
    t.act(p.id, String(type), amount);
    sync(room);
  });

  handle('sitout', ({ value }) => {
    const { room, p } = current();
    p.sittingOut = Boolean(value);
    sync(room);
  });

  handle('buyin', () => {
    const { room, t, p } = current();
    if (room.ended) throw new Error('This game has ended');
    t.buyIn(p.id);
    sync(room);
  });

  // Host ends the game: finish the current hand, then work out who pays whom.
  handle('end', () => {
    const { room, t, p } = current();
    if (p.id !== room.hostId) throw new Error('Only the host can end the game');
    if (room.ended) return;
    if (t.handActive) room.ending = true;
    else endGame(room);
    sync(room);
  });

  handle('leave', () => leave(socket));

  socket.on('disconnect', () => {
    const { code, playerId } = socket.data || {};
    const room = rooms.get(code);
    if (!room || room.sockets.get(playerId) !== socket) return;
    room.sockets.delete(playerId);
    const p = room.table.getPlayer(playerId);
    if (p) p.connected = false; // keep the seat so they can come back
    if (room.sockets.size === 0) room.emptySince = Date.now();
    sync(room);
  });
});

// Clean up tables nobody has been connected to for a while.
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.emptySince && Date.now() - room.emptySince > EMPTY_ROOM_MS) {
      clearTimeout(room.turnTimer);
      clearTimeout(room.nextHandTimer);
      rooms.delete(code);
    }
  }
}, 60_000);

server.listen(PORT, () => console.log(`Poker server running on http://localhost:${PORT}`));
