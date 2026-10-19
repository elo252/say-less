// Say Less — game server. Run with `npm start`, then open the site on any phone or laptop.
const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Room, GameError } = require('./src/game');
const auth = require('./src/auth');
const { bankSize } = require('./src/prompts');

const PORT = Number(process.env.PORT || 3000);
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
const LOBBY_DROP_MS = 30 * 1000;
const HOST_HANDOVER_MS = 45 * 1000; // if the host's phone is gone this long, the next player gets the controls

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e5,
  // Reject the connection outright when the site password is on and this device hasn't entered it.
  allowRequest: (req, cb) => cb(null, auth.isAuthed(req.headers.cookie)),
});
const rooms = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Render/Railway/etc., so secure cookies and client IPs work
app.get('/healthz', (_req, res) => res.send('ok'));
auth.install(app);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (_req, res) => res.redirect('/')); // old link: hosting now happens on the main page

app.get('/api/info', (_req, res) => {
  res.json({
    publicUrl: process.env.PUBLIC_URL || null,
    lanUrls: lanUrls(),
  });
});

app.get('/api/qr', async (req, res) => {
  try {
    const svg = await QRCode.toString(String(req.query.text || '').slice(0, 500), {
      type: 'svg',
      margin: 1,
      color: { dark: '#1c1530', light: '#ffffff' },
    });
    res.type('image/svg+xml').send(svg);
  } catch {
    res.status(400).end();
  }
});

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
  }
  return out;
}

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O — too easy to misread
  let code;
  do code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  while (rooms.has(code));
  return code;
}

/** Push each screen its own view of the room. */
function sync(room) {
  room.touch();
  for (const p of room.players.values()) {
    if (p.socketId) io.to(p.socketId).emit('player:state', room.playerView(p.id));
  }
}

/** Run a handler and answer the client's acknowledgement with {ok, ...} or {ok:false, error}. */
function handle(cb, fn) {
  const reply = typeof cb === 'function' ? cb : () => {};
  try {
    reply({ ok: true, ...(fn() || {}) });
  } catch (e) {
    if (e instanceof GameError) reply({ ok: false, error: e.message });
    else {
      console.error(e);
      reply({ ok: false, error: 'Something went wrong.' });
    }
  }
}

io.on('connection', (socket) => {
  let room = null;
  let playerId = null;
  const findRoom = (code) => rooms.get(String(code || '').toUpperCase().trim());

  function seat(r, p) {
    if (p.socketId && p.socketId !== socket.id) io.to(p.socketId).emit('player:replaced');
    p.socketId = socket.id;
    p.connected = true;
    room = r;
    playerId = p.id;
    sync(r);
    return { playerId: p.id, code: r.code, name: p.name };
  }

  // Create a room: the creator becomes the first player and the host.
  socket.on('player:create', (d, cb) =>
    handle(cb, () => {
      const name = String(d?.name || '').trim();
      if (!name) throw new GameError('Pick a name first.');
      const code = newCode();
      const r = new Room(code, sync);
      rooms.set(code, r);
      return seat(r, r.addPlayer(name));
    })
  );

  socket.on('player:join', (d, cb) =>
    handle(cb, () => {
      const r = findRoom(d?.code);
      if (!r) throw new GameError("Can't find that room code.");
      return seat(r, r.addPlayer(d?.name, d?.playerId));
    })
  );

  const inRoom = (fn) => (d, cb) =>
    handle(cb, () => {
      if (!room || !playerId) throw new GameError('Join a room first.');
      return fn(d || {});
    });
  const hostOnly = (fn) => inRoom((d) => {
    if (!room.isHost(playerId)) throw new GameError('Only the host can do that.');
    return fn(d);
  });

  socket.on('player:submit', inRoom((d) => { room.submit(playerId, d); room.afterSubmit(); }));
  socket.on('player:vote', inRoom((d) => room.vote(playerId, d.category, d.sid)));

  socket.on('host:settings', hostOnly((d) => { room.updateSettings(d); sync(room); }));
  socket.on('host:start', hostOnly(() => room.start()));
  socket.on('host:skip', hostOnly(() => room.skipPhase()));
  socket.on('host:next', hostOnly(() => room.advance()));
  socket.on('host:playAgain', hostOnly(() => room.toLobby()));

  socket.on('disconnect', () => {
    if (!room || !playerId) return;
    const r = room;
    const id = playerId;
    const p = r.players.get(id);
    if (!p || p.socketId !== socket.id) return; // already reconnected elsewhere
    p.connected = false;
    p.socketId = null;
    // A phone that locks briefly shouldn't lose its seat; only drop lobby players who stay gone.
    setTimeout(() => {
      const still = r.players.get(id);
      if (still && !still.connected && r.phase === 'lobby') { r.removePlayer(id); sync(r); }
    }, LOBBY_DROP_MS);
    if (r.isHost(id)) {
      setTimeout(() => { if (r.passHostIfGone()) sync(r); }, HOST_HANDOVER_MS);
    }
    r.checkProgress();
    sync(r);
  });
});

// Clean up abandoned rooms.
setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, r] of rooms) if (r.lastActive < cutoff) { r.destroy(); rooms.delete(code); }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`\n  Say Less is running.\n`);
  console.log(`  Open on this computer:            http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  Phones on the same Wi-Fi:         ${u}`);
  if (process.env.PUBLIC_URL) console.log(`  Public link:                          ${process.env.PUBLIC_URL}`);
  console.log(`  Password protection: ${auth.enabled() ? 'ON' : auth.locked() ? 'LOCKED until GAME_PASSWORD is set' : 'off (set GAME_PASSWORD to turn on)'}`);
  console.log(`  Prompt bank: ${Object.entries(bankSize()).map(([k, v]) => `${v.toLocaleString()} ${k}`).join(', ')}\n`);
});

module.exports = { server, rooms };
