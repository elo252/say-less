// Core game logic. No networking in here — server.js wires it to Socket.io.
// Every device is a player. Whoever creates the room is also the host: they play like everyone
// else and also get the Start / Next / End-early buttons. Every state change ends in this.sync(this).
const crypto = require('crypto');
const { pickPrompt } = require('./prompts');
const TIPS = require('./bank/tips');
const { ADJECTIVES, CREATURES, AVATARS } = require('./bank/aliases');

const MIN_PLAYERS = Number(process.env.MIN_PLAYERS || 3); // includes the host
const MAX_PLAYERS = 12;
const ROUNDS = Number(process.env.ROUNDS || 6);
const POINTS_PER_VOTE = 100;
const WINNER_BONUS = 100;

const MODES = {
  link: {
    id: 'link',
    name: 'The Missing Link',
    tagline: 'Connect two things that have no business being connected.',
    maxWords: 40,
    submitSecs: 60,
    voteSecs: 30,
    categories: [
      { id: 'creative', label: 'Most Creative' },
      { id: 'convincing', label: 'Most Convincing' },
    ],
  },
  pitch: {
    id: 'pitch',
    name: 'One Line Pitch',
    tagline: 'One sentence. Twenty words. Make it land.',
    maxWords: 20,
    submitSecs: 60,
    voteSecs: 30,
    categories: [{ id: 'best', label: 'Clearest & Funniest' }],
  },
};

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

class Room {
  constructor(code, sync = () => {}) {
    this.code = code;
    this.sync = sync;
    this.hostId = null;
    this.players = new Map();
    this.phase = 'lobby'; // lobby → submit → vote → results → … → final
    this.settings = { modes: ['link', 'pitch'], revealAuthors: true };
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

  // ---------- Players & host ----------

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
    if (!this.hostId) this.hostId = player.id; // the room's creator
    this.touch();
    return player;
  }

  isHost(playerId) { return !!playerId && playerId === this.hostId; }

  /** If the host has left, hand the controls to the next connected player. */
  passHostIfGone() {
    const host = this.players.get(this.hostId);
    if (host && host.connected) return false;
    const next = this.connectedPlayers()[0];
    if (!next || next.id === this.hostId) return false;
    this.hostId = next.id;
    return true;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
    if (this.hostId === playerId) {
      this.hostId = null;
      const next = this.connectedPlayers()[0] || [...this.players.values()][0];
      if (next) this.hostId = next.id;
    }
  }

  updateSettings(s = {}) {
    if (!['lobby', 'final'].includes(this.phase)) throw new GameError('Change settings between games.');
    if (Array.isArray(s.modes)) {
      const modes = [...new Set(s.modes.filter((m) => MODES[m]))];
      if (!modes.length) throw new GameError('Pick at least one mode.');
      this.settings.modes = modes;
    }
    if (typeof s.revealAuthors === 'boolean') this.settings.revealAuthors = s.revealAuthors;
  }

  start() {
    if (!['lobby', 'final'].includes(this.phase)) throw new GameError('A game is already running.');
    if (this.connectedPlayers().length < MIN_PLAYERS) throw new GameError(`You need at least ${MIN_PLAYERS} players.`);
    const order = ['link', 'pitch'].filter((m) => this.settings.modes.includes(m));
    this.plan = Array.from({ length: ROUNDS }, (_, i) => order[i % order.length]);
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
    this.setTimer(mode.submitSecs * 1000, () => this.endSubmit());
    this.sync(this);
  }

  submit(playerId, data = {}) {
    const r = this.round;
    if (this.phase !== 'submit' || !r) throw new GameError('Submissions are closed.');
    if (!this.players.has(playerId)) throw new GameError('You are not in this room.');
    if (r.submissions.has(playerId)) throw new GameError('You already locked in.');
    const words = String(data.text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.length) throw new GameError('Write something first!');
    if (words.length > this.mode.maxWords) throw new GameError(`Keep it to ${this.mode.maxWords} words.`);
    const sub = { sid: crypto.randomBytes(6).toString('hex'), playerId, text: words.join(' ').slice(0, 600) };
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

  /** Close answers, give each one an anonymous alias, and open voting. */
  endSubmit() {
    if (this.phase !== 'submit') return;
    this.clearTimer();
    const r = this.round;
    const subs = shuffle([...r.submissions.values()]);
    const adjs = shuffle(ADJECTIVES);
    const creatures = shuffle(CREATURES);
    subs.forEach((s, i) => {
      const [creature, emoji] = creatures[i % creatures.length];
      s.alias = `${adjs[i % adjs.length]} ${creature}`;
      s.emoji = emoji;
    });
    r.order = subs.map((s) => s.sid);
    if (subs.length < 2) return this.finishRound(); // nothing to vote between
    this.phase = 'vote';
    r.deadline = now() + this.mode.voteSecs * 1000;
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
      const points = voteCount * POINTS_PER_VOTE + wins.length * WINNER_BONUS;
      const author = this.players.get(s.playerId);
      if (author) author.score += points;
      return { sid: s.sid, playerId: s.playerId, votes, voteCount, wins, points };
    });
    r.results = { entries, winners };
    r.tip = pick(TIPS[mode.id]);
    r.deadline = null;
    this.phase = 'results';
    this.sync(this);
  }

  /** Host pressed "end early": close the current timed phase now. */
  skipPhase() {
    if (this.phase === 'submit') this.endSubmit();
    else if (this.phase === 'vote') this.finishRound();
  }

  advance() {
    if (this.phase === 'results') this.nextRound();
  }

  // ---------- What each phone is allowed to see ----------

  leaderboard() {
    return [...this.players.values()]
      .sort((a, b) => b.score - a.score)
      .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, connected: p.connected }));
  }

  playerView(playerId) {
    const me = this.players.get(playerId);
    const r = this.round;
    const mode = this.mode;
    const board = this.leaderboard();
    const host = this.players.get(this.hostId);
    const showAnswers = this.phase === 'vote' || this.phase === 'results';
    let results = null;
    if (this.phase === 'results' && r?.results) {
      results = {
        winners: r.results.winners,
        entries: r.results.entries.map((e) => {
          const p = this.players.get(e.playerId);
          const mine = e.playerId === playerId;
          return {
            sid: e.sid,
            votes: e.votes,
            voteCount: e.voteCount,
            wins: e.wins,
            points: e.points,
            mine,
            // Authors are only named after voting, and only if the host left "reveal" on.
            author: (this.settings.revealAuthors || mine) && p ? { name: p.name, avatar: p.avatar } : null,
          };
        }),
      };
    }
    return {
      code: this.code,
      phase: this.phase,
      serverNow: now(),
      minPlayers: MIN_PLAYERS,
      totalRounds: ROUNDS,
      isHost: this.isHost(playerId),
      hostName: host?.name || null,
      settings: this.settings,
      me: me && { id: me.id, name: me.name, avatar: me.avatar, score: me.score },
      rank: board.findIndex((p) => p.id === playerId) + 1,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        connected: p.connected,
        isHost: p.id === this.hostId,
        submitted: !!r && r.submissions.has(p.id),
        voted: this.phase === 'vote' && this.hasVoted(p.id),
      })),
      round: r && {
        index: this.roundIndex,
        total: this.plan.length,
        mode,
        prompt: { text: r.prompt.text, parts: r.prompt.parts || null },
        deadline: r.deadline,
        submitted: r.submissions.has(playerId),
        answers: showAnswers
          ? this.subs().map((s) => ({ sid: s.sid, alias: s.alias, emoji: s.emoji, text: s.text, mine: s.playerId === playerId }))
          : [],
        myVotes: r.votes.get(playerId) || {},
        results,
        tip: r.tip,
      },
      leaderboard: board,
    };
  }
}

module.exports = { Room, GameError, MODES, MIN_PLAYERS, ROUNDS };
