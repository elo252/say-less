// Host / TV screen: lobby with QR code, prompts, anonymous reveals, voting, scores.
(() => {
  const { h, setServerNow, timer, logo, modeChip, transcriptEl, load, save } = SL;
  const app = document.getElementById('app');
  const socket = io();
  // The site password is on and this device hasn't entered it (or it changed): go to the login page.
  socket.on('connect_error', async () => {
    try {
      const r = await fetch('/api/info', { cache: 'no-store' });
      if (r.status === 401) location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    } catch {}
  });
  const STORE = 'sayless.host';

  let state = null;
  let screenKey = '';
  let info = { lanUrls: [], publicUrl: null, whisper: false };
  let session = load(STORE); // { code, hostKey }
  let revealToken = 0;

  fetch('/api/info').then((r) => r.json()).then((j) => { info = j; if (state?.phase === 'lobby') { screenKey = ''; render(); } }).catch(() => {});

  // ---------- Audio ----------

  let ctx = null;
  function audioCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function tone(freq, dur, type = 'sine', vol = 0.2, when = 0) {
    const c = audioCtx();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, c.currentTime + when);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + when + dur);
    o.connect(g).connect(c.destination);
    o.start(c.currentTime + when);
    o.stop(c.currentTime + when + dur + 0.05);
  }
  const sfx = {
    buzzer: () => { tone(98, 0.8, 'square', 0.22); tone(104, 0.8, 'sawtooth', 0.14); },
    ding: () => { tone(880, 0.25, 'triangle', 0.2); tone(1320, 0.45, 'triangle', 0.18, 0.12); },
    pop: () => tone(520, 0.12, 'sine', 0.15),
    fanfare: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.35, 'triangle', 0.18, i * 0.12)),
  };

  let current = null; // whatever is playing right now, so "skip" can stop it
  function stopCurrent() {
    try { current?.stop(); } catch {}
    current = null;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  /**
   * Play a voice clip through a disguise so friends can't recognise each other.
   * helium/deep change pitch (and speed); robot ring-modulates the voice and keeps the timing.
   */
  async function playDisguised(arrayBuffer, effect, bars) {
    const c = audioCtx();
    const buf = await c.decodeAudioData(arrayBuffer.slice(0));
    const src = c.createBufferSource();
    src.buffer = buf;
    let node = src;
    if (effect === 'helium') src.playbackRate.value = 1.35;
    if (effect === 'deep') src.playbackRate.value = 0.76;
    if (effect === 'robot') {
      const ring = c.createGain();
      ring.gain.value = 0;
      const osc = c.createOscillator();
      osc.frequency.value = 52;
      osc.connect(ring.gain);
      osc.start();
      src.connect(ring);
      node = ring;
      src.addEventListener('ended', () => osc.stop());
    }
    const comp = c.createDynamicsCompressor();
    const out = c.createGain();
    out.gain.value = effect === 'robot' ? 2.2 : 1.3;
    const analyser = c.createAnalyser();
    analyser.fftSize = 64;
    node.connect(comp).connect(out).connect(analyser).connect(c.destination);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf;
    const draw = () => {
      analyser.getByteFrequencyData(data);
      bars.forEach((b, i) => { b.style.height = `${10 + (data[(i * 2) % data.length] / 255) * 70}px`; });
      raf = requestAnimationFrame(draw);
    };
    draw();
    return new Promise((resolve) => {
      const done = () => { cancelAnimationFrame(raf); bars.forEach((b) => (b.style.height = '12px')); resolve(); };
      src.addEventListener('ended', done);
      current = { stop: () => { try { src.stop(); } catch {} done(); } };
      src.start();
    });
  }

  let voices = [];
  const loadVoices = () => { voices = ('speechSynthesis' in window ? speechSynthesis.getVoices() : []).filter((v) => /^en/i.test(v.lang)); };
  if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

  /** Read text aloud. Rotates voices so nobody's answer sounds "like them". */
  function speak(text, i = 0) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      if (voices.length) u.voice = voices[i % voices.length];
      u.rate = 1.02;
      let finished = false;
      const end = () => { if (!finished) { finished = true; resolve(); } };
      u.onend = end;
      u.onerror = end;
      current = { stop: end };
      speechSynthesis.speak(u);
      setTimeout(end, 4000 + text.length * 90); // some browsers never fire onend
    });
  }

  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); current = { stop: () => { clearTimeout(t); r(); } }; });

  // ---------- Connection ----------

  socket.on('connect', () => {
    if (session) {
      socket.emit('host:rejoin', session, (res) => {
        if (!res.ok) { session = null; save(STORE, null); splash(); }
      });
    } else if (!state) splash();
  });

  socket.on('host:state', (s) => {
    setServerNow(s.serverNow);
    const prev = state;
    state = s;
    if (prev && prev.phase !== s.phase) onPhaseChange(prev.phase, s.phase);
    render();
  });

  function onPhaseChange(from, to) {
    if (!ctx) return;
    if (to === 'submit' || to === 'vote') sfx.pop();
    if (to === 'results') sfx.ding();
    if (to === 'final') sfx.fanfare();
  }

  function act(event, data) {
    return new Promise((resolve) => socket.emit(event, data || {}, (res) => {
      if (!res?.ok && res?.error) toast(res.error);
      resolve(res);
    }));
  }

  function toast(msg) {
    const t = h('div', { class: 'pill', style: 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#000;color:#fff;font-size:1.1rem;z-index:9' }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ---------- Rendering ----------

  function keyFor(s) {
    const r = s.round;
    switch (s.phase) {
      case 'lobby': return `lobby|${JSON.stringify(s.players.map((p) => [p.id, p.connected]))}|${JSON.stringify(s.settings)}|${info.lanUrls.length}`;
      case 'submit': return `submit|${r.index}|${s.players.map((p) => `${p.submitted}${p.connected}`).join('')}`;
      case 'reveal': return `reveal|${r.index}`;
      case 'vote': return `vote|${r.index}|${r.votedCount}|${s.players.length}`;
      case 'results': return `results|${r.index}`;
      default: return `${s.phase}|${r?.index}`;
    }
  }

  function render() {
    const key = keyFor(state);
    if (key === screenKey) return;
    screenKey = key;
    if (state.phase !== 'reveal') { revealToken++; stopCurrent(); }
    const screens = { lobby, submit, processing, reveal, vote, results, final };
    app.replaceChildren(...[].concat((screens[state.phase] || lobby)()));
    soundBanner();
  }

  function soundBanner() {
    if (ctx && ctx.state === 'running') return;
    if (state?.phase === 'lobby' && !ctx) return; // the Start button unlocks audio
    const b = h('button', { class: 'btn danger sound-banner', onclick: () => { audioCtx(); b.remove(); } }, '🔈 Tap to turn on sound');
    app.append(b);
  }

  function topBar(extra) {
    const r = state.round;
    return h('div', { class: 'h-top' },
      logo(),
      h('span', { class: 'spacer' }),
      r && state.phase !== 'final' ? h('span', { class: 'pill', style: 'font-size:1.1rem' }, `Round ${r.index + 1} of ${r.total}`) : null,
      h('span', { class: 'pill', style: 'font-size:1.1rem' }, `Room ${state.code}`),
      extra || null
    );
  }

  // ---------- Splash ----------

  function splash() {
    screenKey = 'splash';
    app.replaceChildren(h('div', { class: 'h-splash' }, h('div', {},
      logo(),
      h('p', {}, 'The anonymous party game that makes everyone a sharper speaker. Grab your phones.'),
      h('button', { class: 'btn', style: 'font-size:1.6rem;padding:22px 40px', onclick: async (e) => {
        audioCtx();
        e.currentTarget.disabled = true;
        const res = await act('host:create');
        if (res.ok) { session = { code: res.code, hostKey: res.hostKey }; save(STORE, session); }
      } }, 'Create a room')
    )));
  }

  // ---------- Lobby ----------

  function joinBase() {
    if (info.publicUrl) return info.publicUrl.replace(/\/$/, '');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    return local && info.lanUrls[0] ? info.lanUrls[0] : location.origin;
  }

  function lobby() {
    const s = state;
    const base = joinBase();
    const url = `${base}/?room=${s.code}`;
    const connected = s.players.filter((p) => p.connected);
    const insecure = base.startsWith('http://') && !/localhost|127\.0\.0\.1/.test(base);
    const set = (patch) => act('host:settings', { ...s.settings, ...patch });

    const seg = (options, value, onPick) => h('div', { class: 'seg' },
      options.map(([v, label]) => h('button', { class: v === value ? 'on' : '', onclick: () => onPick(v) }, label)));
    const modeSeg = h('div', { class: 'seg' }, [['link', 'Missing Link'], ['ums', "No 'Ums'"], ['pitch', 'One Line Pitch']].map(([m, label]) => {
      const on = s.settings.modes.includes(m);
      return h('button', { class: on ? 'on' : '', onclick: () => {
        const modes = on ? s.settings.modes.filter((x) => x !== m) : [...s.settings.modes, m];
        if (modes.length) set({ modes });
      } }, label);
    }));

    return [
      topBar(),
      h('div', { class: 'lobby' },
        h('div', { class: 'join-box stack' },
          h('div', { class: 'qr' }, h('img', { src: `/api/qr?text=${encodeURIComponent(url)}`, alt: `QR code to join room ${s.code}` })),
          h('div', { class: 'room-code' }, s.code),
          h('div', { class: 'join-url' }, `Scan, or go to ${base.replace(/^https?:\/\//, '')} and enter the code`),
          insecure && s.settings.modes.includes('ums')
            ? h('div', { class: 'warn' }, "Heads up: phones only allow the mic on https links. Text rounds work fine here; for the No 'Ums' round, use an https link (see the README) or players can type instead.")
            : null
        ),
        h('div', { class: 'stack', style: 'gap:22px' },
          h('div', { class: 'row' },
            h('h2', { style: 'font-size:2rem' }, `Players (${connected.length})`),
            h('span', { class: 'spacer' }),
            connected.length < s.minPlayers ? h('span', { class: 'muted' }, `Need ${s.minPlayers - connected.length} more`) : null
          ),
          s.players.length
            ? h('div', { class: 'players-grid' }, s.players.map((p) =>
                h('div', { class: `player-tile${p.connected ? '' : ' off'}` }, h('div', { class: 'em' }, p.avatar), h('div', { class: 'nm' }, p.name))))
            : h('p', { class: 'muted', style: 'font-size:1.3rem' }, 'Waiting for the first brave soul…'),
          h('div', { class: 'settings' },
            h('div', { class: 'set-row' }, h('span', {}, 'Rounds'), seg([[3, '3'], [6, '6'], [9, '9']], s.settings.rounds, (v) => set({ rounds: v }))),
            h('div', { class: 'set-row' }, h('span', {}, 'Modes'), modeSeg),
            h('div', { class: 'set-row' }, h('span', {}, 'Voice disguise'),
              seg([['random', 'Random'], ['helium', 'Helium'], ['deep', 'Deep'], ['robot', 'Robot'], ['none', 'Off']], s.settings.disguise, (v) => set({ disguise: v }))),
            h('div', { class: 'set-row' }, h('span', {}, 'After voting'),
              seg([[true, 'Reveal who wrote what'], [false, 'Stay anonymous']], s.settings.revealAuthors, (v) => set({ revealAuthors: v })))
          ),
          h('button', {
            class: 'btn',
            style: 'font-size:1.5rem;padding:20px;align-self:flex-start;min-width:260px',
            disabled: connected.length < s.minPlayers,
            onclick: () => { audioCtx(); act('host:start'); },
          }, 'Start the game')
        )
      ),
    ];
  }

  // ---------- Submit ----------

  function promptBlock(r) {
    return r.prompt.parts
      ? h('div', { class: 'pair-big' }, h('div', { class: 'obj' }, r.prompt.parts[0]), h('div', { class: 'plus' }, '+'), h('div', { class: 'obj' }, r.prompt.parts[1]))
      : h('div', { class: 'prompt-big' }, r.prompt.text);
  }

  function statusRow(flag) {
    return h('div', { class: 'status-row' }, state.players.filter((p) => p.connected).map((p) =>
      h('div', { class: `player-tile${p[flag] ? ' done' : ''}` }, h('div', { class: 'em' }, p.avatar), h('div', { class: 'nm' }, p.name))));
  }

  function submit() {
    const r = state.round;
    const instructions = {
      link: 'On your phone: explain how these two are connected.',
      ums: 'On your phone: tap to talk for 30–45 seconds. Every "um" costs you.',
      pitch: 'On your phone: one sentence, twenty words max.',
    }[r.mode.id];
    return [
      topBar(h('button', { class: 'btn ghost', onclick: () => act('host:skip') }, 'End early')),
      h('div', { class: 'stage' },
        modeChip(r.mode),
        promptBlock(r),
        h('div', { class: 'tagline' }, instructions),
        timer(r.deadline, 'big-timer'),
        statusRow('submitted')
      ),
    ];
  }

  function processing() {
    return [topBar(), h('div', { class: 'stage' },
      h('div', { class: 'spinner', style: 'width:90px;height:90px' }),
      h('div', { class: 'prompt-big' }, 'Counting the ums…'),
      h('div', { class: 'tagline' }, 'Disguising voices. Judging silently.')
    )];
  }

  // ---------- Reveal ----------

  function reveal() {
    const r = state.round;
    const holder = h('div', { class: 'stage' });
    const dots = h('div', { class: 'counter-dots' }, r.submissions.map(() => h('i')));
    let skip = () => {};
    const skipBtn = h('button', { class: 'btn ghost', onclick: () => skip() }, 'Next ▶');
    const token = ++revealToken;

    (async () => {
      await new Promise((res) => { current = null; setTimeout(res, 300); });
      for (let i = 0; i < r.submissions.length; i++) {
        if (token !== revealToken) return;
        const s = r.submissions[i];
        [...dots.children].forEach((d, j) => d.classList.toggle('on', j <= i));
        let skipped = false;
        skip = () => { skipped = true; stopCurrent(); };
        const card = h('div', { class: 'card reveal-card' }, h('div', { class: 'who' }, h('span', { class: 'em' }, s.emoji), s.alias));
        holder.replaceChildren(h('div', { class: 'tagline' }, `Answer ${i + 1} of ${r.submissions.length}`), card, dots);

        if (s.kind === 'voice') {
          const bars = Array.from({ length: 18 }, () => h('i'));
          const label = h('div', { class: 'meta' }, h('span', { class: 'tag' }, `🎙️ ${s.disguise === 'none' ? 'Undisguised' : `${s.disguise[0].toUpperCase()}${s.disguise.slice(1)} voice`}`));
          card.append(h('div', { class: 'wave' }, bars), label);
          try {
            const res = await act('host:getAudio', { sid: s.sid });
            if (res.ok && !skipped && token === revealToken) {
              await playDisguised(res.audio, s.disguise === 'none' ? null : s.disguise, bars);
            }
          } catch (e) {
            console.warn('Playback failed', e);
            card.append(h('p', { class: 'muted' }, "Couldn't play this clip on this screen."));
          }
          if (token !== revealToken) return;
          card.querySelector('.wave')?.remove();
          card.append(h('div', { class: 'transcript' }, transcriptEl(s.segments, s.transcript || '(no transcript)')));
          const meta = h('div', { class: 'meta' },
            h('span', { class: 'tag' }, `${Math.round(s.durationSec || 0)}s`),
            s.fillers == null
              ? h('span', { class: 'tag' }, 'Fluency not measured')
              : h('span', { class: 'tag' }, `${s.fillers} filler${s.fillers === 1 ? '' : 's'} · ${s.perMin}/min`),
            s.fillers != null && !s.bust ? h('span', { class: 'tag', style: 'background:var(--mint)' }, `+${s.fluencyPoints} fluency`) : null
          );
          label.replaceWith(meta);
          if (s.bust) { card.append(h('div', { class: 'stamp' }, 'Bust!')); sfx.buzzer(); }
          if (!skipped) await sleep(s.bust ? 3500 : 2800);
        } else {
          card.append(h('div', { class: 'says' }, `“${s.text}”`));
          if (s.kind === 'typed') card.append(h('div', { class: 'meta' }, h('span', { class: 'tag' }, '⌨️ Typed — no fluency score')));
          if (!skipped) await speak(s.text, i);
          if (!skipped) await sleep(1400);
        }
      }
      if (token === revealToken) act('host:revealDone', { roundIndex: r.index });
    })();

    return [topBar(skipBtn), h('div', { class: 'reveal-head' }, modeChip(r.mode), h('div', { style: 'font-size:1.6rem;color:var(--muted);max-width:60ch' }, r.prompt.text)), holder];
  }

  // ---------- Vote ----------

  function answerText(s) {
    if (s.kind === 'voice') return s.transcript ? transcriptEl(s.segments, s.transcript) : '🎙️ (voice clip)';
    return s.text;
  }

  function vote() {
    const r = state.round;
    const voters = state.players.filter((p) => p.connected).length;
    return [
      topBar(h('button', { class: 'btn ghost', onclick: () => act('host:skip') }, 'End voting')),
      h('div', { class: 'stage', style: 'justify-content:flex-start' },
        h('div', { class: 'row', style: 'gap:24px' },
          h('h1', { style: 'font-size:3rem' }, 'Vote on your phones!'),
          timer(r.deadline, 'big-timer')
        ),
        h('div', { class: 'tagline' }, `${r.mode.categories.map((c) => c.label).join(' + ')} · ${r.votedCount}/${voters} voted`),
        h('div', { class: 'grid-cards' }, r.submissions.map((s) =>
          h('div', { class: 'card' }, h('div', { class: 'who' }, h('span', { class: 'em' }, s.emoji), s.alias), h('div', { class: 'txt' }, answerText(s))))),
        statusRow('voted')
      ),
    ];
  }

  // ---------- Results ----------

  function scoreboard() {
    return h('div', { class: 'scoreboard' }, h('h3', {}, 'Scores'),
      state.leaderboard.map((p, i) => h('div', { class: 'score-row' }, h('span', {}, `${i + 1}.`), h('span', {}, p.avatar), h('span', {}, p.name), h('span', { class: 'sc' }, p.score))));
  }

  function results() {
    const r = state.round;
    const res = r.results || { entries: [], winners: {} };
    const bySid = Object.fromEntries(r.submissions.map((s) => [s.sid, s]));
    const entries = [...res.entries].sort((a, b) => b.points - a.points);
    const last = r.index + 1 >= r.total;
    return [
      topBar(),
      h('div', { class: 'stage', style: 'justify-content:flex-start' },
        h('h1', { style: 'font-size:3rem' }, entries.length ? 'Round results' : 'Nobody answered!'),
        h('div', { class: 'results-layout' },
          h('div', { class: 'grid-cards' }, entries.map((e) => {
            const s = bySid[e.sid] || {};
            const winLabels = e.wins.map((w) => r.mode.categories.find((c) => c.id === w)?.label);
            return h('div', { class: `card${e.wins.length ? ' win' : ''}` },
              h('div', { class: 'pts' }, `+${e.points}`),
              h('div', { class: 'who' }, h('span', { class: 'em' }, s.emoji), s.alias),
              h('div', { class: 'txt' }, answerText(s)),
              h('div', { class: 'badges' },
                winLabels.map((l) => h('span', { class: 'badge' }, `🏆 ${l}`)),
                h('span', { class: 'badge mint' }, `${e.voteCount} vote${e.voteCount === 1 ? '' : 's'}`),
                s.kind === 'voice' && s.bust ? h('span', { class: 'badge red' }, `💥 Bust (${s.fillers} fillers)`) : null,
                s.kind === 'voice' && !s.bust && s.fillers != null ? h('span', { class: 'badge mint' }, `+${e.fluencyPoints} fluency`) : null
              ),
              e.author ? h('div', { class: 'author' }, `${e.author.avatar} ${e.author.name}`) : null
            );
          })),
          h('div', { class: 'stack' },
            scoreboard(),
            r.tip ? h('div', { class: 'tip', style: 'font-size:1.1rem' }, h('b', {}, "Coach's tip"), r.tip) : null,
            h('button', { class: 'btn', style: 'font-size:1.4rem', onclick: () => act('host:next') }, last ? 'See final scores' : 'Next round ▶')
          )
        )
      ),
    ];
  }

  // ---------- Final ----------

  function final() {
    const lb = state.leaderboard;
    const step = (p, place) => p
      ? h('div', { class: `step p${place}` }, h('div', { class: 'place' }, ['🥇', '🥈', '🥉'][place - 1]), h('div', { class: 'em' }, p.avatar), h('div', { class: 'nm' }, p.name), h('div', { class: 'sc' }, `${p.score} pts`))
      : h('div', { class: `step p${place}`, style: 'opacity:.25' });
    return [
      topBar(),
      h('div', { class: 'stage' },
        h('h1', { style: 'font-size:3.4rem' }, lb[0] ? `${lb[0].name} wins!` : 'Game over'),
        h('div', { class: 'podium' }, step(lb[1], 2), step(lb[0], 1), step(lb[2], 3)),
        lb.length > 3 ? h('div', { class: 'scoreboard', style: 'min-width:320px' }, lb.slice(3).map((p, i) =>
          h('div', { class: 'score-row' }, h('span', {}, `${i + 4}.`), h('span', {}, p.avatar), h('span', {}, p.name), h('span', { class: 'sc' }, p.score)))) : null,
        h('div', { class: 'h-controls' },
          h('button', { class: 'btn', style: 'font-size:1.4rem', onclick: () => act('host:playAgain') }, 'Play again'),
          h('button', { class: 'btn ghost', onclick: () => { save(STORE, null); location.reload(); } }, 'New room')
        )
      ),
    ];
  }
})();
