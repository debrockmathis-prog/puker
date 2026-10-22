const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Table } = require('./engine/table');

const PORT = process.env.PORT || process.argv[2] || 3000;
const TURN_MS = 30_000;          // time to act before auto check/fold
const DISCONNECTED_TURN_MS = 10_000;
const NEXT_HAND_MS = 5_000;      // pause to show results between hands
const EMPTY_ROOM_MS = 30 * 60_000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));
// Servers browsers use to find each other for video. Set ICE_SERVERS (JSON) to add a TURN server.
const ICE_SERVERS = process.env.ICE_SERVERS
  ? JSON.parse(process.env.ICE_SERVERS)
  : [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
app.get('/config', (_req, res) => res.json({ iceServers: ICE_SERVERS }));
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

const clampInt = (v, min, max, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const cleanName = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 16);

function createRoom(settings) {
  const bigBlind = clampInt(settings.bigBlind, 2, 100_000, 20);
  const room = {
    code: makeCode(),
    table: new Table({
      bigBlind,
      smallBlind: Math.max(1, Math.floor(bigBlind / 2)),
      startingChips: clampInt(settings.startingChips, bigBlind * 10, 10_000_000, 1000),
    }),
    hostId: null,
    started: false,
    tokens: new Map(),   // secret token -> player id (lets you rejoin after a refresh)
    sockets: new Map(),  // player id -> socket
    cams: new Set(),     // player ids with their camera on
    turnTimer: null,
    turnKey: null,
    turnDeadline: null,
    nextHandTimer: null,
    emptySince: null,
  };
  rooms.set(room.code, room);
  return room;
}

function broadcast(room) {
  // Each connected player's socket id tells browsers when to (re)start a video connection.
  const video = {};
  for (const [id, sock] of room.sockets) video[id] = { session: sock.id, cam: room.cams.has(id) };
  for (const [playerId, socket] of room.sockets) {
    socket.emit('state', {
      code: room.code,
      you: playerId,
      hostId: room.hostId,
      started: room.started,
      turnDeadline: room.turnDeadline,
      serverNow: Date.now(),
      turnMs: TURN_MS,
      video,
      table: room.table.view(playerId),
    });
  }
}

// Called after every change: keeps timers in step with the table, then sends state.
function sync(room) {
  const t = room.table;

  // The turn always passes to someone else after an action, so this changes exactly when a new turn starts.
  const key = t.handActive ? `${t.handNumber}:${t.phase}:${t.turn}` : null;
  if (key !== room.turnKey) {
    room.turnKey = key;
    clearTimeout(room.turnTimer);
    room.turnDeadline = null;
    if (key) {
      const p = t.seats[t.turn];
      const ms = p.connected ? TURN_MS : DISCONNECTED_TURN_MS;
      room.turnDeadline = Date.now() + ms;
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
      }, ms);
    }
  }

  if (room.started && !t.handActive && !room.nextHandTimer && t.eligiblePlayers().length >= 2) {
    const delay = t.phase === 'handover' ? NEXT_HAND_MS : 1500;
    room.nextHandTimer = setTimeout(() => {
      room.nextHandTimer = null;
      if (!t.handActive) t.startHand();
      sync(room);
    }, delay);
  }

  broadcast(room);
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
    if (t.players.some((o) => o.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('That name is taken at this table');
    }
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
  room.cams.delete(playerId);
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

  handle('create', ({ name, token, settings = {} }) => {
    name = cleanName(name);
    if (!name) throw new Error('Enter a name');
    if (socket.data?.code) leave(socket);
    seatPlayer(socket, createRoom(settings), { name, token: String(token) });
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

  handle('rebuy', () => {
    const { room, t, p } = current();
    t.rebuy(p.id);
    sync(room);
  });

  handle('cam', ({ on }) => {
    const { room, p } = current();
    if (on) room.cams.add(p.id);
    else room.cams.delete(p.id);
    broadcast(room);
  });

  // Video call signaling: pass WebRTC offers/answers/candidates between two players at the same table.
  socket.on('rtc', ({ to, data } = {}) => {
    const { code, playerId } = socket.data || {};
    const target = rooms.get(code)?.sockets.get(to);
    if (target && to !== playerId) target.emit('rtc', { from: playerId, session: socket.id, data });
  });

  handle('leave', () => leave(socket));

  socket.on('disconnect', () => {
    const { code, playerId } = socket.data || {};
    const room = rooms.get(code);
    if (!room || room.sockets.get(playerId) !== socket) return;
    room.sockets.delete(playerId);
    room.cams.delete(playerId);
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
