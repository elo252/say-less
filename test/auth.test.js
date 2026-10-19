// Password gate: pages, API and sockets are locked until the password is entered.
const assert = require('assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3998;
const URL = `http://localhost:${PORT}`;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), GAME_PASSWORD: 'pancake-pirates' },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const tryConnect = (cookie) => new Promise((res) => {
  const s = io(URL, { transports: ['websocket'], extraHeaders: cookie ? { cookie } : {}, reconnection: false, timeout: 3000 });
  s.on('connect', () => { s.close(); res(true); });
  s.on('connect_error', () => { s.close(); res(false); });
});
const login = (password, next = '/host') => fetch(`${URL}/login`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password, next }),
});

async function main() {
  await new Promise((res) => srv.stdout.on('data', (d) => d.toString().includes('running') && res()));

  let r = await fetch(`${URL}/?room=ABCD`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login?next=%2F%3Froom%3DABCD');
  console.log('  ✓ pages redirect to the password screen (and remember the room code)');

  assert.equal((await fetch(`${URL}/api/info`)).status, 401);
  assert.equal((await fetch(`${URL}/host.js`, { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(`${URL}/healthz`)).status, 200);
  assert.equal((await fetch(`${URL}/login`)).status, 200);
  console.log('  ✓ API and scripts locked; health check and login page open');

  assert.equal(await tryConnect(), false);
  assert.equal(await tryConnect('sl_auth=forged'), false);
  console.log('  ✓ game connections refused without the password');

  r = await login('wrong');
  assert.match(r.headers.get('location'), /error=1/);
  assert.equal(r.headers.get('set-cookie'), null);
  r = await login('pancake-pirates', '//evil.example.com');
  assert.equal(r.headers.get('location'), '/'); // no open redirects
  r = await login('pancake-pirates', '/?room=ABCD');
  assert.equal(r.headers.get('location'), '/?room=ABCD');
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  console.log('  ✓ wrong password rejected; right password sets a cookie and returns to the room');

  assert.equal((await fetch(`${URL}/host`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${URL}/api/info`, { headers: { cookie } })).status, 200);
  assert.equal(await tryConnect(cookie), true);
  console.log('  ✓ with the cookie: pages, API and game connection all work');

  for (let i = 0; i < 9; i++) await login('nope');
  r = await login('pancake-pirates');
  assert.match(r.headers.get('location'), /error=2/);
  console.log('  ✓ password guessing is rate-limited');

  // Locked mode: REQUIRE_PASSWORD on, no password yet → nothing is reachable.
  const LP = 3997;
  const locked = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(LP), REQUIRE_PASSWORD: 'true', GAME_PASSWORD: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((res) => locked.stdout.on('data', (d) => d.toString().includes('running') && res()));
    assert.equal((await fetch(`http://localhost:${LP}/host`)).status, 503);
    assert.equal((await fetch(`http://localhost:${LP}/api/info`)).status, 503);
    assert.equal((await fetch(`http://localhost:${LP}/healthz`)).status, 200);
    const ok = await new Promise((res) => {
      const s = io(`http://localhost:${LP}`, { transports: ['websocket'], reconnection: false, timeout: 3000 });
      s.on('connect', () => { s.close(); res(true); });
      s.on('connect_error', () => { s.close(); res(false); });
    });
    assert.equal(ok, false);
    console.log('  ✓ with REQUIRE_PASSWORD and no password set, the site stays locked');
  } finally { locked.kill(); }

  console.log('\nPassword test passed');
}

main()
  .catch((e) => { console.error('\n✗', e); process.exitCode = 1; })
  .finally(() => { srv.kill(); setTimeout(() => process.exit(), 100); });
