// Say Less — game server. Run with `npm start`, then open /host on the TV/laptop.
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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 8e6,
  // Reject the connection outright when the site password is on and this device hasn't entered it.
  allowRequest: (req, cb) => cb(null, auth.isAuthed(req.headers.cookie)),
});
const rooms = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Render/Railway/etc., so secure cookies and client IPs work
app.get('/healthz', (_req, res) => res.send('ok'));
auth.install(app);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

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
  if (room.hostSocketId) io.to(room.hostSocketId).emit('host:state', room.hostView());
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

/** Filler counting uses the transcript the phone made with its own speech recognition — no AI service. */
function scoreVoice(room, sub) {
  // Resolve on the next tick so the round can first register that everyone has submitted.
  setImmediate(() => room.setTranscript(sub.sid, sub.browserTranscript || null, sub.browserTranscript ? 'browser' : null));
}

io.on('connection', (socket) => {
  let role = null;
  let room = null;
  let playerId = null;
  const findRoom = (code) => rooms.get(String(code || '').toUpperCase().trim());

  // ----- Host -----
  socket.on('host:create', (_d, cb) =>
    handle(cb, () => {
      const code = newCode();
      room = new Room(code, sync);
      rooms.set(code, room);
      room.hostSocketId = socket.id;
      role = 'host';
      sync(room);
      return { code, hostKey: room.hostKey };
    })
  );

  socket.on('host:rejoin', (d, cb) =>
    handle(cb, () => {
      const r = findRoom(d?.code);
      if (!r || r.hostKey !== d?.hostKey) throw new GameError('That room has closed.');
      room = r;
      role = 'host';
      r.hostSocketId = socket.id;
      sync(r);
      return { code: r.code };
    })
  );

  const hostOnly = (fn) => (d, cb) =>
    handle(cb, () => {
      if (role !== 'host' || !room) throw new GameError('Only the host can do that.');
      return fn(d || {});
    });

  socket.on('host:settings', hostOnly((d) => { room.updateSettings(d); sync(room); }));
  socket.on('host:start', hostOnly(() => room.start()));
  socket.on('host:revealDone', hostOnly((d) => room.endReveal(d.roundIndex)));
  socket.on('host:skip', hostOnly(() => room.skipPhase()));
  socket.on('host:next', hostOnly(() => room.advance()));
  socket.on('host:playAgain', hostOnly(() => room.toLobby()));
  socket.on('host:getAudio', hostOnly((d) => {
    const s = room.findSub(d.sid);
    if (!s?.audio) throw new GameError('No audio for that answer.');
    return { audio: s.audio, mime: s.mime };
  }));

  // ----- Players -----
  socket.on('player:join', (d, cb) =>
    handle(cb, () => {
      const r = findRoom(d?.code);
      if (!r) throw new GameError("Can't find that room code.");
      const p = r.addPlayer(d?.name, d?.playerId);
      if (p.socketId && p.socketId !== socket.id) io.to(p.socketId).emit('player:replaced');
      p.socketId = socket.id;
      p.connected = true;
      room = r;
      role = 'player';
      playerId = p.id;
      sync(r);
      return { playerId: p.id, code: r.code, name: p.name };
    })
  );

  const playerOnly = (fn) => (d, cb) =>
    handle(cb, () => {
      if (role !== 'player' || !room) throw new GameError('Join a room first.');
      return fn(d || {});
    });

  socket.on('player:submit', playerOnly((d) => {
    const sub = room.submit(playerId, d);
    if (sub.kind === 'voice') scoreVoice(room, sub);
    room.afterSubmit();
  }));

  socket.on('player:vote', playerOnly((d) => room.vote(playerId, d.category, d.sid)));

  socket.on('disconnect', () => {
    if (!room) return;
    const r = room;
    if (role === 'host' && r.hostSocketId === socket.id) r.hostSocketId = null;
    if (role === 'player') {
      const p = r.players.get(playerId);
      if (p && p.socketId === socket.id) {
        p.connected = false;
        p.socketId = null;
        const id = playerId;
        // A phone that locks briefly shouldn't lose its seat; only drop lobby players who stay gone.
        setTimeout(() => {
          const still = r.players.get(id);
          if (still && !still.connected && r.phase === 'lobby') {
            r.players.delete(id);
            sync(r);
          }
        }, LOBBY_DROP_MS);
        r.checkProgress();
      }
    }
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
  console.log(`  Host screen (open on the TV/laptop):  http://localhost:${PORT}/host`);
  for (const u of lanUrls()) console.log(`  Phones on the same Wi-Fi join at:     ${u}`);
  if (process.env.PUBLIC_URL) console.log(`  Public link:                          ${process.env.PUBLIC_URL}`);
  console.log(`  Password protection: ${auth.enabled() ? 'ON' : 'off (set GAME_PASSWORD to turn on)'}`);
  console.log(`  Prompt bank: ${Object.entries(bankSize()).map(([k, v]) => `${v.toLocaleString()} ${k}`).join(', ')}\n`);
});

module.exports = { server, rooms };
