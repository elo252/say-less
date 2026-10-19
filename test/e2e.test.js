// End-to-end: real server, three phones over Socket.io (one of them hosts), one full game.
// Run: node test/e2e.test.js
const assert = require('assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;
const ROUNDS = 4;

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), ROUNDS: String(ROUNDS), GAME_PASSWORD: '', REQUIRE_PASSWORD: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const ask = (sock, ev, data) => new Promise((res) => sock.emit(ev, data, res));
const connect = () => new Promise((res) => { const s = io(URL, { transports: ['websocket'] }); s.on('connect', () => res(s)); });
const waitFor = (get, pred, label) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const s = get();
    if (s && pred(s)) { clearInterval(iv); res(s); }
    else if (Date.now() - t0 > 8000) { clearInterval(iv); rej(new Error(`Timed out waiting for ${label}; phase=${s?.phase}`)); }
  }, 20);
});

async function phone() {
  const sock = await connect();
  const p = { sock, state: null };
  sock.on('player:state', (s) => (p.state = s));
  return p;
}

async function main() {
  await new Promise((res) => srv.stdout.on('data', (d) => d.toString().includes('running') && res()));

  // The host creates the room from their own phone and is player #1.
  const host = await phone();
  const created = await ask(host.sock, 'player:create', { name: 'Dhruv' });
  assert.ok(created.ok && /^[A-Z]{4}$/.test(created.code), created.error);
  await waitFor(() => host.state, (s) => s.phase === 'lobby', 'host lobby');
  assert.equal(host.state.isHost, true);
  assert.equal(host.state.players.length, 1);
  console.log(`  ✓ host created room ${created.code} and is already a player`);

  const ben = await phone();
  const cy = await phone();
  assert.ok((await ask(ben.sock, 'player:join', { code: created.code.toLowerCase(), name: 'Ben' })).ok);
  assert.equal((await ask(host.sock, 'host:start', {})).ok, false); // only 2 players
  assert.ok((await ask(cy.sock, 'player:join', { code: created.code, name: 'Cy' })).ok);
  await waitFor(() => host.state, (s) => s.players.length === 3, 'three players');
  assert.equal(ben.state.isHost, false);
  assert.equal((await ask(ben.sock, 'host:start', {})).ok, false);
  console.log('  ✓ needs 3 players including the host; only the host can start');

  assert.ok((await ask(host.sock, 'host:start', {})).ok);
  const phones = [host, ben, cy];

  for (let round = 0; round < ROUNDS; round++) {
    for (const p of phones) await waitFor(() => p.state, (s) => s.phase === 'submit' && s.round.index === round, `round ${round}`);
    const mode = host.state.round.mode;
    for (const [i, p] of phones.entries()) {
      assert.ok((await ask(p.sock, 'player:submit', { text: `Answer ${i} for round ${round}` })).ok);
    }
    for (const p of phones) await waitFor(() => p.state, (s) => s.phase === 'vote', 'vote');
    for (const p of phones) {
      const answers = p.state.round.answers;
      assert.equal(answers.length, 3);
      assert.ok(!/Dhruv|Ben|"Cy"/.test(JSON.stringify(answers)), 'answers must be anonymous');
      const target = answers.find((a) => !a.mine);
      for (const c of mode.categories) assert.ok((await ask(p.sock, 'player:vote', { category: c.id, sid: target.sid })).ok);
    }
    const res = await waitFor(() => host.state, (s) => s.phase === 'results', 'results');
    const total = res.round.results.entries.reduce((a, e) => a + e.voteCount, 0);
    assert.equal(total, 3 * mode.categories.length);
    assert.equal((await ask(ben.sock, 'host:next', {})).ok, false);
    console.log(`  ✓ round ${round + 1} (${mode.name}): host played, ${total} votes counted`);
    assert.ok((await ask(host.sock, 'host:next', {})).ok);
  }

  const fin = await waitFor(() => host.state, (s) => s.phase === 'final', 'final');
  console.log(`  ✓ game over — ${fin.leaderboard[0].name} wins with ${fin.leaderboard[0].score} pts`);

  // A phone that reloads gets its seat back.
  ben.sock.disconnect();
  const again = await connect();
  const rejoin = await ask(again, 'player:join', { code: created.code, playerId: ben.state.me.id });
  assert.ok(rejoin.ok && rejoin.playerId === ben.state.me.id);
  console.log('  ✓ reconnecting phone keeps its seat and score');

  assert.equal((await fetch(`${URL}/host`, { redirect: 'manual' })).status, 302);
  console.log('  ✓ old /host link sends people to the main page');
  console.log('\nEnd-to-end test passed');
}

main()
  .catch((e) => { console.error('\n✗', e); process.exitCode = 1; })
  .finally(() => { srv.kill(); setTimeout(() => process.exit(), 100); });
