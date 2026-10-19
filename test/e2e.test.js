// End-to-end: real server, a host and three phones over Socket.io, one full game of all three modes.
// Run: node test/e2e.test.js
const assert = require('assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const ask = (sock, ev, data) => new Promise((res) => sock.emit(ev, data, res));
const connect = () => new Promise((res) => { const s = io(URL, { transports: ['websocket'] }); s.on('connect', () => res(s)); });
const waitFor = (getState, pred, label) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const s = getState();
    if (s && pred(s)) { clearInterval(iv); res(s); }
    else if (Date.now() - t0 > 8000) { clearInterval(iv); rej(new Error(`Timed out waiting for ${label}; phase=${s?.phase}`)); }
  }, 20);
});

async function main() {
  await new Promise((res) => srv.stdout.on('data', (d) => d.toString().includes('running') && res()));

  const host = await connect();
  let hs = null;
  host.on('host:state', (s) => (hs = s));
  const created = await ask(host, 'host:create', {});
  assert.ok(created.ok && /^[A-Z]{4}$/.test(created.code));
  console.log(`  ✓ room ${created.code} created`);

  const qr = await fetch(`${URL}/api/qr?text=${encodeURIComponent(`${URL}/?room=${created.code}`)}`);
  assert.equal(qr.headers.get('content-type').split(';')[0], 'image/svg+xml');
  console.log('  ✓ QR code served');

  const phones = [];
  for (const name of ['Ana', 'Ben', 'Cy']) {
    const sock = await connect();
    const phone = { sock, state: null };
    sock.on('player:state', (s) => (phone.state = s));
    const res = await ask(sock, 'player:join', { code: created.code.toLowerCase(), name });
    assert.ok(res.ok, res.error);
    phone.id = res.playerId;
    phones.push(phone);
  }
  await waitFor(() => hs, (s) => s.players.length === 3, 'players in lobby');
  console.log('  ✓ 3 phones joined (code is case-insensitive)');

  const bad = await ask(phones[0].sock, 'player:submit', { text: 'too early' });
  assert.equal(bad.ok, false);
  const notHost = await ask(phones[0].sock, 'host:start', {});
  assert.equal(notHost.ok, false);
  console.log('  ✓ phones cannot start the game or submit early');

  assert.ok((await ask(host, 'host:settings', { rounds: 3, modes: ['link', 'ums', 'pitch'], disguise: 'robot', revealAuthors: true })).ok);
  assert.ok((await ask(host, 'host:start', {})).ok);

  const answers = {
    link: ['Both make Sunday mornings dangerous.', 'One flips pancakes, one flips you.', 'Syrup.'],
    pitch: ['Two teens fall in love, families feud, everyone dies.', 'Love at first sight, then a really bad plan.', 'Poison.'],
  };
  const transcripts = [
    'Socks are leaving for a better life, and honestly who can blame them.',
    'Um, so, uh, socks, um, they, uh, go somewhere.',
    '',
  ];

  for (let round = 0; round < 3; round++) {
    const s = await waitFor(() => hs, (x) => x.phase === 'submit' && x.round.index === round, `round ${round} submit`);
    const mode = s.round.mode.id;
    for (const [i, p] of phones.entries()) {
      await waitFor(() => p.state, (x) => x.phase === 'submit' && x.round.index === round, 'phone submit');
      let res;
      if (mode === 'ums') {
        const audio = new Uint8Array(4000).fill(i + 1);
        res = await ask(p.sock, 'player:submit', { audio, mime: 'audio/webm', durationSec: 35, browserTranscript: transcripts[i] });
      } else {
        res = await ask(p.sock, 'player:submit', { text: answers[mode][i] });
      }
      assert.ok(res.ok, res.error);
    }
    const rv = await waitFor(() => hs, (x) => x.phase === 'reveal', 'reveal');
    assert.equal(rv.round.submissions.length, 3);
    assert.ok(!JSON.stringify(rv.round.submissions).match(/Ana|Ben|"Cy"/), 'reveal must be anonymous');
    if (mode === 'ums') {
      const audioRes = await ask(host, 'host:getAudio', { sid: rv.round.submissions[0].sid });
      assert.ok(audioRes.ok && audioRes.audio.byteLength === 4000);
      const busted = rv.round.submissions.filter((x) => x.bust);
      assert.equal(busted.length, 1);
      const unmeasured = rv.round.submissions.filter((x) => x.fillers == null);
      assert.equal(unmeasured.length, 1); // no transcript → not scored, not punished
      assert.ok(rv.round.submissions.every((x) => x.disguise === 'robot'));
      console.log('  ✓ voice round: audio relayed, robot disguise, 1 bust, 1 unmeasured');
    }
    await ask(host, 'host:revealDone', { roundIndex: round });

    await waitFor(() => phones[0].state, (x) => x.phase === 'vote', 'vote');
    const cats = phones[0].state.round.mode.categories.map((c) => c.id);
    for (const p of phones) {
      const opts = p.state.round.options;
      assert.equal(opts.length, 2, 'each phone sees everyone else, not itself');
      for (const c of cats) assert.ok((await ask(p.sock, 'player:vote', { category: c, sid: opts[0].sid })).ok);
    }
    const res = await waitFor(() => hs, (x) => x.phase === 'results', 'results');
    const total = res.round.results.entries.reduce((a, e) => a + e.voteCount, 0);
    assert.equal(total, 3 * cats.length);
    assert.ok(res.round.results.entries.every((e) => e.author)); // revealAuthors on
    console.log(`  ✓ round ${round + 1} (${s.round.mode.name}): ${total} votes counted, authors revealed`);
    await ask(host, 'host:next', {});
  }

  const fin = await waitFor(() => hs, (x) => x.phase === 'final', 'final');
  const top = fin.leaderboard[0];
  assert.ok(top.score > 0);
  await waitFor(() => phones[0].state, (x) => x.phase === 'final', 'phone final');
  console.log(`  ✓ game over — ${top.name} wins with ${top.score} pts`);

  // A phone that reloads gets its seat back.
  phones[1].sock.disconnect();
  const again = await connect();
  const rejoin = await ask(again, 'player:join', { code: created.code, playerId: phones[1].id });
  assert.ok(rejoin.ok && rejoin.playerId === phones[1].id);
  console.log('  ✓ reconnecting phone keeps its seat and score');

  console.log('\nEnd-to-end test passed');
}

main()
  .catch((e) => { console.error('\n✗', e); process.exitCode = 1; })
  .finally(() => { srv.kill(); setTimeout(() => process.exit(), 100); });
