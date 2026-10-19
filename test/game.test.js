// Unit tests for the game rules (no network). Run: node test/game.test.js
const assert = require('assert/strict');
const { Room, GameError } = require('../src/game');
const Fillers = require('../public/fillers');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('fillers');
test('counts hesitation fillers but not real words', () => {
  const a = Fillers.analyze('Um, so I think, uh, the ocean is, like, salty because, you know, hmm, fish. I like umbrellas and the summer.');
  assert.equal(a.count, 5); // um, uh, like, you know, hmm — not "like umbrellas", "umbrellas" or "summer"
  assert.equal(a.segments.filter((s) => s.t === 'filler').map((s) => s.s.toLowerCase()).join(','), 'um,uh,like,you know,hmm');
});
test('scores per minute and busts above the threshold', () => {
  assert.equal(Fillers.score(0, 40).points, 300);
  assert.equal(Fillers.score(0, 15).points, 150); // short speech → fewer points
  assert.equal(Fillers.score(3, 40).bust, false); // 4.5/min — under the line
  assert.equal(Fillers.score(4, 40).bust, true); // 6/min — bust
  assert.equal(Fillers.score(4, 40).points, 0);
  assert.equal(Fillers.score(2, 10).bust, false); // fewer than 3 fillers never busts
});

console.log('room');
function makeRoom() {
  const room = new Room('TEST');
  const ps = ['Ana', 'Ben', 'Cy'].map((n) => room.addPlayer(n));
  room.updateSettings({ rounds: 3 });
  return { room, ps };
}

test('needs 3 players and dedupes names', () => {
  const room = new Room('X');
  room.addPlayer('Ana');
  const b = room.addPlayer('ana');
  assert.equal(b.name, 'ana 2');
  assert.throws(() => room.start(), GameError);
});

test('full text round: submit, reveal, vote, score', () => {
  const { room, ps } = makeRoom();
  room.start();
  assert.equal(room.phase, 'submit');
  assert.equal(room.round.mode, 'link');
  assert.throws(() => room.submit(ps[0].id, { text: 'x '.repeat(41) }), /40 words/);
  ps.forEach((p, i) => { room.submit(p.id, { text: `Answer ${i}` }); room.afterSubmit(); });
  assert.equal(room.phase, 'reveal'); // everyone in → moves on early
  // The host screen must not learn who wrote what during reveal.
  const hv = room.hostView();
  assert.equal(JSON.stringify(hv.round.submissions).includes(ps[0].id), false);
  room.endReveal(0);
  assert.equal(room.phase, 'vote');
  const sidOf = (p) => room.round.submissions.get(p.id).sid;
  assert.throws(() => room.vote(ps[0].id, 'creative', sidOf(ps[0])), /yourself/);
  // Everyone votes for Ana's answer in both categories (Ana votes Ben).
  room.vote(ps[0].id, 'creative', sidOf(ps[1]));
  room.vote(ps[0].id, 'convincing', sidOf(ps[1]));
  room.vote(ps[1].id, 'creative', sidOf(ps[0]));
  room.vote(ps[1].id, 'convincing', sidOf(ps[0]));
  room.vote(ps[2].id, 'creative', sidOf(ps[0]));
  assert.equal(room.phase, 'vote');
  room.vote(ps[2].id, 'convincing', sidOf(ps[0]));
  assert.equal(room.phase, 'results');
  assert.equal(ps[0].score, 4 * 100 + 2 * 100); // 4 votes + 2 category wins
  assert.equal(ps[1].score, 2 * 100);
  assert.equal(ps[2].score, 0);
  room.destroy();
});

test('voice round: fluency points, bust, and transcript fallback', () => {
  const { room, ps } = makeRoom();
  room.updateSettings({ modes: ['ums'] });
  room.start();
  assert.equal(room.round.mode, 'ums');
  const audio = Buffer.alloc(2000, 1);
  const a = room.submit(ps[0].id, { audio, durationSec: 40, browserTranscript: 'Socks are portals to another dimension.' });
  const b = room.submit(ps[1].id, { audio, durationSec: 40, browserTranscript: 'Um, uh, so, um, like, socks, uh, yeah.' });
  const c = room.submit(ps[2].id, { typed: true, text: 'I typed this one.' });
  room.afterSubmit();
  assert.equal(room.phase, 'processing'); // waiting for transcripts
  room.setTranscript(a.sid, a.browserTranscript, 'browser');
  assert.equal(room.phase, 'processing');
  room.setTranscript(b.sid, b.browserTranscript, 'browser');
  assert.equal(room.phase, 'reveal');
  assert.equal(a.fluencyPoints, 300);
  assert.equal(b.bust, true);
  assert.equal(c.kind, 'typed');
  room.endReveal();
  room.skipPhase(); // nobody votes
  assert.equal(room.phase, 'results');
  assert.equal(ps[0].score, 300);
  assert.equal(ps[1].score, 0);
  room.destroy();
});

test('player view hides other authors until results', () => {
  const { room, ps } = makeRoom();
  room.updateSettings({ revealAuthors: false });
  room.start();
  ps.forEach((p, i) => { room.submit(p.id, { text: `A${i}` }); room.afterSubmit(); });
  room.endReveal();
  const v = room.playerView(ps[0].id);
  assert.equal(v.round.options.length, 2); // can't see own answer as an option
  room.skipPhase();
  const hv = room.hostView();
  assert.ok(hv.round.results.entries.every((e) => e.author === null)); // anonymous mode keeps names hidden
  room.destroy();
});

test('game ends after the planned rounds', () => {
  const { room, ps } = makeRoom();
  room.start();
  for (let i = 0; i < 3; i++) {
    room.skipPhase(); // nobody answers
    assert.equal(room.phase, 'results');
    room.advance();
  }
  assert.equal(room.phase, 'final');
  room.destroy();
});

console.log(`\n${passed} tests passed`);
