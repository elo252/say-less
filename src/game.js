// Core game logic. No networking in here — server.js wires it to Socket.io.
// Every state change ends in this.sync(this), which pushes fresh views to the host and phones.
const crypto = require('crypto');
const { pickPrompt } = require('./prompts');
const Fillers = require('../public/fillers');

const MIN_PLAYERS = Number(process.env.MIN_PLAYERS || 3);
const MAX_PLAYERS = 12;
const BUST_PER_MIN = Number(process.env.BUST_PER_MIN || Fillers.DEFAULT_BUST_PER_MIN);
const POINTS_PER_VOTE = 100;
const WINNER_BONUS = 100;
const VOICE_GRACE_MS = 3000; // lets a phone that's mid-recording finish uploading after the clock hits zero

const MODES = {
  link: {
    id: 'link',
    name: 'The Missing Link',
    tagline: 'Connect two things that have no business being connected.',
    input: 'text',
    maxWords: 40,
    submitSecs: 60,
    voteSecs: 30,
    categories: [
      { id: 'creative', label: 'Most Creative' },
      { id: 'convincing', label: 'Most Convincing' },
    ],
    tips: [
      'Look for a shared job: what does each thing actually do? Two different objects often solve the same problem.',
      'Put both objects in one scene. A tiny story is easier to believe than an abstract link.',
      'Find one shared property — shape, sound, material — then exaggerate it.',
      'Use one as a metaphor for the other: "a lighthouse is a jellyfish that decided to get a job."',
    ],
  },
  ums: {
    id: 'ums',
    name: "No 'Ums' Allowed",
    tagline: 'Talk for 30–45 seconds. No ums. No uhs. The robot is listening.',
    input: 'voice',
    maxWords: 120, // only used for the typed fallback
    recordMinSecs: 10,
    recordMaxSecs: 45,
    submitSecs: 75,
    voteSecs: 30,
    categories: [{ id: 'best', label: 'Most Entertaining' }],
    tips: [
      'Swap "um" for a silent pause. A pause sounds confident; a filler sounds unsure.',
      'Plan your first sentence before you hit record — most fillers show up in the first five seconds.',
      'Use a simple frame: point, example, punchline. Knowing what comes next keeps the "uh"s away.',
      'Slow down. Fillers appear when your mouth gets ahead of your brain.',
    ],
  },
  pitch: {
    id: 'pitch',
    name: 'One Line Pitch',
    tagline: 'One sentence. Twenty words. Make it land.',
    input: 'text',
    maxWords: 20,
    submitSecs: 60,
    voteSecs: 30,
    categories: [{ id: 'best', label: 'Clearest & Funniest' }],
    tips: [
      'Start with the verb: what actually happens?',
      'Cut adjectives first — they rarely carry the meaning.',
      'Decide the one thing your listener must remember, then build the sentence around it.',
      'Try "X, but Y, so Z" — conflict and payoff in a single line.',
    ],
  },
};

const ADJECTIVES = ['Secret', 'Anonymous', 'Mysterious', 'Masked', 'Incognito', 'Undercover', 'Hidden', 'Shadowy', 'Covert', 'Phantom', 'Disguised', 'Nameless'];
const CREATURES = [
  ['Alpaca', '🦙'], ['Flamingo', '🦩'], ['Otter', '🦦'], ['Octopus', '🐙'], ['Penguin', '🐧'], ['Sloth', '🦥'],
  ['Hedgehog', '🦔'], ['Peacock', '🦚'], ['Raccoon', '🦝'], ['Narwhal', '🐋'], ['Moose', '🫎'], ['Parrot', '🦜'],
];
const AVATARS = ['🦊', '🐸', '🐼', '🐯', '🦉', '🐢', '🦋', '🐳', '🐝', '🦀', '🦁', '🐨', '🐙', '🦄'];
const DISGUISES = ['helium', 'deep', 'robot'];

class GameError extends Error {}

const now = () => Date.now();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function modeMeta(mode) {
  const { tips, ...rest } = mode;
  return rest;
}

class Room {
  constructor(code, sync = () => {}) {
    this.code = code;
    this.sync = sync;
    this.hostKey = crypto.randomUUID();
    this.hostSocketId = null;
    this.players = new Map();
    this.phase = 'lobby'; // lobby → submit → (processing) → reveal → vote → results → … → final
    this.settings = { rounds: 6, modes: ['link', 'ums', 'pitch'], disguise: 'random', revealAuthors: true };
    this.plan = [];
    this.roundIndex = -1;
    this.round = null;
    this.timer = null;
    this.usedPrompts = new Set();
    this.touch();
  }

  touch() { this.lastActive = now(); }
  clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  setTimer(ms, fn) {
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; fn(); }, ms);
  }
  destroy() { this.clearTimer(); }

  get mode() { return this.round ? MODES[this.round.mode] : null; }
  connectedPlayers() { return [...this.players.values()].filter((p) => p.connected); }
  subs() { return this.round ? this.round.order.map((sid) => this.findSub(sid)).filter(Boolean) : []; }
  findSub(sid) {
    if (!this.round) return null;
    for (const s of this.round.submissions.values()) if (s.sid === sid) return s;
    return null;
  }

  // ---------- Lobby ----------

  addPlayer(rawName, playerId) {
    if (playerId && this.players.has(playerId)) return this.players.get(playerId); // reconnect
    let name = String(rawName || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!name) throw new GameError('Pick a name first.');
    if (this.players.size >= MAX_PLAYERS) throw new GameError(`Room is full (${MAX_PLAYERS} max).`);
    const taken = (n) => [...this.players.values()].some((p) => p.name.toLowerCase() === n.toLowerCase());
    for (let base = name, n = 2; taken(name); n++) name = `${base.slice(0, 13)} ${n}`;
    const usedAvatars = new Set([...this.players.values()].map((p) => p.avatar));
    const avatar = AVATARS.find((a) => !usedAvatars.has(a)) || pick(AVATARS);
    const player = { id: crypto.randomUUID(), name, avatar, score: 0, socketId: null, connected: true };
    this.players.set(player.id, player);
    this.touch();
    return player;
  }

  updateSettings(s = {}) {
    if (!['lobby', 'final'].includes(this.phase)) throw new GameError('Change settings between games.');
    if ([3, 6, 9].includes(Number(s.rounds))) this.settings.rounds = Number(s.rounds);
    if (Array.isArray(s.modes)) {
      const modes = s.modes.filter((m) => MODES[m]);
      if (!modes.length) throw new GameError('Pick at least one mode.');
      this.settings.modes = [...new Set(modes)];
    }
    if (['random', 'none', ...DISGUISES].includes(s.disguise)) this.settings.disguise = s.disguise;
    if (typeof s.revealAuthors === 'boolean') this.settings.revealAuthors = s.revealAuthors;
  }

  start() {
    if (!['lobby', 'final'].includes(this.phase)) throw new GameError('A game is already running.');
    if (this.connectedPlayers().length < MIN_PLAYERS) throw new GameError(`You need at least ${MIN_PLAYERS} players.`);
    const order = ['link', 'ums', 'pitch'].filter((m) => this.settings.modes.includes(m));
    this.plan = Array.from({ length: this.settings.rounds }, (_, i) => order[i % order.length]);
    for (const p of this.players.values()) p.score = 0;
    this.roundIndex = -1;
    this.usedPrompts.clear();
    this.nextRound();
  }

  toLobby() {
    this.clearTimer();
    this.phase = 'lobby';
    this.round = null;
    this.plan = [];
    this.roundIndex = -1;
    this.sync(this);
  }

  // ---------- Rounds ----------

  nextRound() {
    this.clearTimer();
    this.roundIndex++;
    if (this.roundIndex >= this.plan.length) {
      this.phase = 'final';
      this.round = null;
      this.sync(this);
      return;
    }
    const mode = MODES[this.plan[this.roundIndex]];
    this.round = {
      mode: mode.id,
      prompt: pickPrompt(mode.id, this.usedPrompts),
      submissions: new Map(), // playerId → submission
      votes: new Map(), // playerId → { category: sid }
      order: [],
      results: null,
      tip: null,
      deadline: now() + mode.submitSecs * 1000,
    };
    this.phase = 'submit';
    const grace = mode.input === 'voice' ? VOICE_GRACE_MS : 0;
    this.setTimer(mode.submitSecs * 1000 + grace, () => this.endSubmit());
    this.sync(this);
  }

  submit(playerId, data = {}) {
    const r = this.round;
    if (this.phase !== 'submit' || !r) throw new GameError('Submissions are closed.');
    if (!this.players.has(playerId)) throw new GameError('You are not in this room.');
    if (r.submissions.has(playerId)) throw new GameError('You already locked in.');
    const mode = this.mode;
    const sub = { sid: crypto.randomBytes(6).toString('hex'), playerId, kind: 'text', text: '' };

    if (mode.input === 'text' || data.typed) {
      const words = String(data.text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      if (!words.length) throw new GameError('Write something first!');
      if (words.length > mode.maxWords) throw new GameError(`Keep it to ${mode.maxWords} words.`);
      sub.text = words.join(' ').slice(0, 600);
      sub.kind = mode.input === 'voice' ? 'typed' : 'text';
    } else {
      const audio = data.audio;
      if (!Buffer.isBuffer(audio) || audio.length < 500) throw new GameError('That recording was empty — try again.');
      if (audio.length > 6e6) throw new GameError('That recording is too large.');
      sub.kind = 'voice';
      sub.audio = audio;
      sub.mime = String(data.mime || 'audio/webm').slice(0, 60);
      sub.durationSec = Math.max(0, Math.min(mode.recordMaxSecs + 2, Number(data.durationSec) || 0));
      sub.browserTranscript = String(data.browserTranscript || '').slice(0, 3000);
      sub.transcript = null;
      sub.transcriptSource = null;
      sub.pending = true; // waiting for speech-to-text
    }
    r.submissions.set(playerId, sub);
    this.touch();
    return sub;
  }

  /** Called after a submission: ends the phase early once every connected player is in. */
  afterSubmit() {
    if (this.phase === 'submit' && this.everyoneSubmitted()) this.endSubmit();
    else this.sync(this);
  }

  everyoneSubmitted() {
    const c = this.connectedPlayers();
    return c.length > 0 && c.every((p) => this.round.submissions.has(p.id));
  }

  setTranscript(sid, transcript, source) {
    const sub = this.findSub(sid);
    if (!sub || !sub.pending) return; // already resolved (e.g. by the timeout fallback)
    sub.pending = false;
    if (transcript != null && String(transcript).trim()) {
      sub.transcript = String(transcript).trim();
      sub.transcriptSource = source;
      const a = Fillers.analyze(sub.transcript);
      const f = Fillers.score(a.count, sub.durationSec, BUST_PER_MIN);
      Object.assign(sub, { fillers: a.count, segments: a.segments, perMin: f.perMin, bust: f.bust, fluencyPoints: f.points });
    } else {
      Object.assign(sub, { fillers: null, segments: null, perMin: null, bust: false, fluencyPoints: 0 });
    }
    if (this.phase === 'processing' && ![...this.round.submissions.values()].some((s) => s.pending)) {
      this.startReveal();
    } else {
      this.sync(this);
    }
  }

  endSubmit() {
    if (this.phase !== 'submit') return;
    this.clearTimer();
    this.round.deadline = null;
    const pending = [...this.round.submissions.values()].filter((s) => s.pending);
    if (pending.length) {
      this.phase = 'processing';
      this.sync(this);
      // Don't let a slow transcription hold the whole room hostage.
      this.setTimer(15000, () => {
        for (const s of pending) if (s.pending) this.setTranscript(s.sid, s.browserTranscript, 'browser');
        if (this.phase === 'processing') this.startReveal();
      });
      return;
    }
    this.startReveal();
  }

  startReveal() {
    this.clearTimer();
    const r = this.round;
    const subs = shuffle([...r.submissions.values()]);
    const adjs = shuffle(ADJECTIVES);
    const creatures = shuffle(CREATURES);
    subs.forEach((s, i) => {
      const [creature, emoji] = creatures[i % creatures.length];
      s.alias = `${adjs[i % adjs.length]} ${creature}`;
      s.emoji = emoji;
      if (s.kind === 'voice') s.disguise = this.settings.disguise === 'random' ? pick(DISGUISES) : this.settings.disguise;
    });
    r.order = subs.map((s) => s.sid);
    if (!subs.length) return this.finishRound();
    this.phase = 'reveal';
    // Safety net in case the host screen never reports back.
    this.setTimer(Math.min(300, 40 * subs.length + 15) * 1000, () => this.endReveal());
    this.sync(this);
  }

  endReveal(roundIndex) {
    if (this.phase !== 'reveal') return;
    if (roundIndex != null && roundIndex !== this.roundIndex) return;
    this.clearTimer();
    if (this.round.submissions.size < 2) return this.finishRound();
    this.phase = 'vote';
    this.round.deadline = now() + this.mode.voteSecs * 1000;
    this.setTimer(this.mode.voteSecs * 1000, () => this.finishRound());
    this.sync(this);
  }

  vote(playerId, category, sid) {
    if (this.phase !== 'vote') throw new GameError('Voting is closed.');
    if (!this.players.has(playerId)) throw new GameError('You are not in this room.');
    if (!this.mode.categories.some((c) => c.id === category)) throw new GameError('Unknown category.');
    const sub = this.findSub(sid);
    if (!sub) throw new GameError('That answer no longer exists.');
    if (sub.playerId === playerId) throw new GameError("Nice try — you can't vote for yourself.");
    const v = this.round.votes.get(playerId) || {};
    v[category] = sid;
    this.round.votes.set(playerId, v);
    if (this.everyoneVoted()) this.finishRound();
    else this.sync(this);
  }

  hasVoted(playerId) {
    const v = this.round?.votes.get(playerId) || {};
    return !!this.mode && this.mode.categories.every((c) => v[c.id]);
  }

  everyoneVoted() {
    const c = this.connectedPlayers();
    return c.length > 0 && c.every((p) => this.hasVoted(p.id));
  }

  /** Re-check whether a phase can end, e.g. after someone disconnects. */
  checkProgress() {
    if (this.phase === 'submit' && this.everyoneSubmitted()) this.endSubmit();
    else if (this.phase === 'vote' && this.everyoneVoted()) this.finishRound();
  }

  finishRound() {
    this.clearTimer();
    const r = this.round;
    const mode = this.mode;
    const subs = this.subs();
    const tally = new Map(subs.map((s) => [s.sid, {}]));
    for (const v of r.votes.values()) {
      for (const [cat, sid] of Object.entries(v)) {
        if (tally.has(sid)) tally.get(sid)[cat] = (tally.get(sid)[cat] || 0) + 1;
      }
    }
    const winners = {};
    for (const c of mode.categories) {
      const max = Math.max(0, ...subs.map((s) => tally.get(s.sid)[c.id] || 0));
      winners[c.id] = max > 0 ? subs.filter((s) => (tally.get(s.sid)[c.id] || 0) === max).map((s) => s.sid) : [];
    }
    const entries = subs.map((s) => {
      const votes = tally.get(s.sid);
      const voteCount = Object.values(votes).reduce((a, b) => a + b, 0);
      const wins = mode.categories.filter((c) => winners[c.id].includes(s.sid)).map((c) => c.id);
      const points = voteCount * POINTS_PER_VOTE + wins.length * WINNER_BONUS + (s.fluencyPoints || 0);
      const author = this.players.get(s.playerId);
      if (author) author.score += points;
      return { sid: s.sid, playerId: s.playerId, votes, voteCount, wins, points, fluencyPoints: s.fluencyPoints || 0 };
    });
    r.results = { entries, winners };
    r.tip = pick(mode.tips);
    r.deadline = null;
    this.phase = 'results';
    this.sync(this);
  }

  /** Host pressed "skip": end the current timed phase now. */
  skipPhase() {
    if (this.phase === 'submit') this.endSubmit();
    else if (this.phase === 'reveal') this.endReveal();
    else if (this.phase === 'vote') this.finishRound();
  }

  advance() {
    if (this.phase === 'results') this.nextRound();
  }

  // ---------- Views (what each screen is allowed to know) ----------

  publicSub(s) {
    return {
      sid: s.sid,
      alias: s.alias,
      emoji: s.emoji,
      kind: s.kind,
      text: s.text,
      durationSec: s.durationSec ?? null,
      transcript: s.transcript ?? null,
      transcriptSource: s.transcriptSource ?? null,
      segments: s.segments ?? null,
      fillers: s.fillers ?? null,
      perMin: s.perMin ?? null,
      bust: !!s.bust,
      fluencyPoints: s.fluencyPoints ?? 0,
      disguise: s.disguise ?? null,
      hasAudio: !!s.audio,
    };
  }

  resultsView(viewerId) {
    const r = this.round;
    if (!r?.results) return null;
    return {
      winners: r.results.winners,
      entries: r.results.entries.map((e) => {
        const p = this.players.get(e.playerId);
        const showAuthor = this.settings.revealAuthors || e.playerId === viewerId;
        return {
          ...e,
          playerId: undefined,
          mine: e.playerId === viewerId,
          author: showAuthor && p ? { name: p.name, avatar: p.avatar } : null,
        };
      }),
    };
  }

  leaderboard() {
    return [...this.players.values()]
      .sort((a, b) => b.score - a.score)
      .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, connected: p.connected }));
  }

  roundBase() {
    const r = this.round;
    if (!r) return null;
    return {
      index: this.roundIndex,
      total: this.plan.length,
      mode: modeMeta(this.mode),
      prompt: { text: r.prompt.text, parts: r.prompt.parts || null },
      deadline: r.deadline,
      submittedCount: r.submissions.size,
      tip: r.tip,
    };
  }

  hostView() {
    const r = this.round;
    const showSubs = ['reveal', 'vote', 'results'].includes(this.phase);
    return {
      code: this.code,
      phase: this.phase,
      settings: this.settings,
      minPlayers: MIN_PLAYERS,
      bustPerMin: BUST_PER_MIN,
      serverNow: now(),
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        score: p.score,
        connected: p.connected,
        submitted: !!r && r.submissions.has(p.id),
        voted: this.phase === 'vote' && this.hasVoted(p.id),
      })),
      round: r && {
        ...this.roundBase(),
        submissions: showSubs ? this.subs().map((s) => this.publicSub(s)) : [],
        votedCount: this.phase === 'vote' ? this.connectedPlayers().filter((p) => this.hasVoted(p.id)).length : 0,
        results: this.resultsView(null),
      },
      leaderboard: this.leaderboard(),
    };
  }

  playerView(playerId) {
    const me = this.players.get(playerId);
    const r = this.round;
    const board = this.leaderboard();
    const mySub = r?.submissions.get(playerId);
    const preview = (s) => {
      const t = s.kind === 'voice' ? s.transcript : s.text;
      if (!t) return '🎙️ Voice clip';
      return t.length > 110 ? `${t.slice(0, 107)}…` : t;
    };
    const results = this.phase === 'results' ? this.resultsView(playerId) : null;
    return {
      code: this.code,
      phase: this.phase,
      serverNow: now(),
      playerCount: this.connectedPlayers().length,
      minPlayers: MIN_PLAYERS,
      me: me && { id: me.id, name: me.name, avatar: me.avatar, score: me.score },
      rank: board.findIndex((p) => p.id === playerId) + 1,
      round: r && {
        ...this.roundBase(),
        submitted: !!mySub,
        mySub: mySub && ['reveal', 'vote', 'results'].includes(this.phase) ? this.publicSub(mySub) : null,
        options:
          this.phase === 'vote'
            ? this.subs()
                .filter((s) => s.playerId !== playerId)
                .map((s) => ({ sid: s.sid, alias: s.alias, emoji: s.emoji, preview: preview(s) }))
            : [],
        myVotes: r.votes.get(playerId) || {},
        results: results && { winners: results.winners, mine: results.entries.find((e) => e.mine) || null },
      },
      leaderboard: this.phase === 'final' || this.phase === 'results' ? board : null,
    };
  }
}

module.exports = { Room, GameError, MODES, MIN_PLAYERS };
