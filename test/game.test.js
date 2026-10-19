// Unit tests for the game rules (no network). Run: node test/game.test.js
const assert = require('assert/strict');
const { Room, GameError, ROUNDS } = require('../src/game');
const { pickPrompt } = require('../src/prompts');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

function makeRoom(names = ['Host', 'Ben', 'Cy']) {
  const room = new Room('TEST');
  const ps = names.map((n) => room.addPlayer(n));
  return { room, ps };
}
const sidOf = (room, p) => room.round.submissions.get(p.id).sid;

console.log('room');

test('the creator is the host and counts as a player', () => {
  const { room, ps } = makeRoom(['Host', 'Ben']);
  assert.equal(room.hostId, ps[0].id);
  assert.equal(room.playerView(ps[0].id).isHost, true);
  assert.equal(room.playerView(ps[1].id).isHost, false);
  assert.throws(() => room.start(), /at least 3/); // host + 1 is not enough
  room.addPlayer('Cy');
  room.start(); // host + 2 is
  assert.equal(room.phase, 'submit');
  room.destroy();
});

test('fixed number of rounds, alternating the two modes', () => {
  const { room } = makeRoom();
  room.start();
  assert.equal(room.plan.length, ROUNDS);
  assert.deepEqual(room.plan.slice(0, 4), ['link', 'pitch', 'link', 'pitch']);
  room.destroy();
});

test('full round: host answers and votes like everyone else', () => {
  const { room, ps } = makeRoom();
  room.start();
  assert.throws(() => room.submit(ps[0].id, { text: 'x '.repeat(41) }), /40 words/);
  ps.forEach((p, i) => { room.submit(p.id, { text: `Answer ${i}` }); room.afterSubmit(); });
  assert.equal(room.phase, 'vote'); // everyone in → straight to voting

  // Nobody's phone can tell who wrote what during voting.
  const view = room.playerView(ps[1].id);
  assert.equal(view.round.answers.length, 3);
  assert.equal(view.round.answers.filter((a) => a.mine).length, 1);
  assert.equal(JSON.stringify(view.round.answers).includes(ps[0].id), false);
  assert.equal(JSON.stringify(view.round.answers).includes('Host'), false);

  assert.throws(() => room.vote(ps[0].id, 'creative', sidOf(room, ps[0])), /yourself/);
  room.vote(ps[0].id, 'creative', sidOf(room, ps[1]));
  room.vote(ps[0].id, 'convincing', sidOf(room, ps[1]));
  room.vote(ps[1].id, 'creative', sidOf(room, ps[0]));
  room.vote(ps[1].id, 'convincing', sidOf(room, ps[0]));
  room.vote(ps[2].id, 'creative', sidOf(room, ps[0]));
  assert.equal(room.phase, 'vote');
  room.vote(ps[2].id, 'convincing', sidOf(room, ps[0]));
  assert.equal(room.phase, 'results');
  assert.equal(ps[0].score, 4 * 100 + 2 * 100); // 4 votes + 2 category wins
  assert.equal(ps[1].score, 2 * 100);
  assert.equal(ps[2].score, 0);
  const results = room.playerView(ps[2].id).round.results;
  assert.ok(results.entries.every((e) => e.author)); // names shown after voting by default
  room.destroy();
});

test('"stay anonymous" hides names even after voting (except your own)', () => {
  const { room, ps } = makeRoom();
  room.updateSettings({ revealAuthors: false });
  room.start();
  ps.forEach((p, i) => { room.submit(p.id, { text: `A${i}` }); room.afterSubmit(); });
  room.skipPhase();
  const entries = room.playerView(ps[0].id).round.results.entries;
  assert.equal(entries.filter((e) => e.author).length, 1);
  assert.ok(entries.find((e) => e.author).mine);
  room.destroy();
});

test('host controls pass to someone else if the host leaves', () => {
  const { room, ps } = makeRoom();
  ps[0].connected = false;
  assert.equal(room.passHostIfGone(), true);
  assert.equal(room.hostId, ps[1].id);
  room.removePlayer(ps[1].id);
  assert.equal(room.hostId, ps[2].id);
  room.destroy();
});

test('fewer than 2 answers skips voting', () => {
  const { room, ps } = makeRoom();
  room.start();
  room.submit(ps[0].id, { text: 'Only me' });
  room.skipPhase();
  assert.equal(room.phase, 'results');
  room.destroy();
});

test('game ends after the planned rounds', () => {
  const { room } = makeRoom();
  room.start();
  for (let i = 0; i < ROUNDS; i++) {
    room.skipPhase(); // nobody answers
    assert.equal(room.phase, 'results');
    room.advance();
  }
  assert.equal(room.phase, 'final');
  room.destroy();
});

test('names are de-duplicated', () => {
  const room = new Room('X');
  room.addPlayer('Ana');
  assert.equal(room.addPlayer('ana').name, 'ana 2');
  assert.throws(() => room.addPlayer('  '), GameError);
});

console.log('prompts');
test('prompts never repeat within a game', () => {
  const used = new Set();
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const p = pickPrompt(i % 2 ? 'pitch' : 'link', used);
    assert.equal(seen.has(p.text), false);
    seen.add(p.text);
  }
});

console.log(`\n${passed} tests passed`);
