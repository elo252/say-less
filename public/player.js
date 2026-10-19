// The one and only screen. Every device is a player; the room's creator also gets host controls.
(() => {
  const { h, setServerNow, wordCount, timer, logo, modeChip, load, save } = SL;
  const app = document.getElementById('app');
  const socket = io();
  const STORE = 'sayless.player';
  const params = new URLSearchParams(location.search);

  // The site password is on and this device hasn't entered it (or it changed): go to the login page.
  socket.on('connect_error', async () => {
    try {
      const r = await fetch('/api/info', { cache: 'no-store' });
      if (r.status === 401) location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    } catch {}
  });

  let state = null;
  let screenKey = '';
  let session = load(STORE); // { code, playerId, name }
  let info = { lanUrls: [], publicUrl: null };
  fetch('/api/info').then((r) => r.json()).then((j) => { info = j; }).catch(() => {});

  // ---------- Connection ----------

  socket.on('connect', () => {
    const urlCode = (params.get('room') || '').toUpperCase();
    if (session && (!urlCode || urlCode === session.code)) {
      socket.emit('player:join', { code: session.code, playerId: session.playerId, name: session.name }, (res) => {
        if (!res.ok) { forget(); renderLanding(res.error === "Can't find that room code." ? 'That game has ended.' : res.error); }
      });
    } else if (!state) {
      renderLanding();
    }
  });

  socket.on('disconnect', () => { if (state) toast('Reconnecting…'); });

  socket.on('player:replaced', () => {
    state = null;
    screenKey = '';
    app.replaceChildren(hero('📱', 'Opened somewhere else', 'You joined from another tab, so this one is paused.'));
  });

  socket.on('player:state', (s) => {
    setServerNow(s.serverNow);
    const wasHost = state?.isHost;
    state = s;
    if (wasHost === false && s.isHost) toast("You're the host now");
    render();
  });

  function forget() {
    session = null;
    save(STORE, null);
    state = null;
    screenKey = '';
    if (params.get('room')) { params.delete('room'); history.replaceState(null, '', '/'); }
  }

  function leave() {
    forget();
    socket.disconnect();
    socket.connect();
    renderLanding();
  }

  function act(event, data) {
    return new Promise((resolve) => socket.emit(event, data || {}, (res) => {
      if (!res?.ok && res?.error) toast(res.error);
      resolve(res || {});
    }));
  }

  function toast(msg) {
    const t = h('div', { class: 'toast' }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  // ---------- Rendering ----------

  function keyFor(s) {
    const r = s.round;
    const roster = s.players.map((p) => `${p.id}${p.connected ? 1 : 0}${p.isHost ? 'h' : ''}`).join(',');
    switch (s.phase) {
      case 'lobby': return `lobby|${roster}|${JSON.stringify(s.settings)}|${s.isHost}`;
      case 'submit': return `submit|${r.index}|${r.submitted}|${s.isHost}`;
      case 'vote': return `vote|${r.index}|${s.isHost}`;
      case 'results': return `results|${r.index}|${s.isHost}`;
      case 'final': return `final|${s.isHost}|${s.me?.score}`;
      default: return s.phase;
    }
  }

  function render() {
    const key = keyFor(state);
    if (key === screenKey) {
      // Same screen: update the live bits in place so typing and scrolling aren't interrupted.
      paintStatus();
      if (state.phase === 'vote') paintVotes();
      return;
    }
    screenKey = key;
    const screens = { lobby, submit, vote, results, final };
    app.replaceChildren(...[].concat((screens[state.phase] || lobby)()).filter(Boolean));
    paintStatus();
    window.scrollTo(0, 0);
  }

  function top() {
    const r = state.round;
    return h('div', { class: 'p-top' },
      h('span', { style: 'font-size:1.6rem' }, state.me?.avatar || ''),
      h('span', { class: 'me' }, state.me?.name || ''),
      state.isHost ? h('span', { class: 'host-tag' }, 'Host') : null,
      h('span', { class: 'spacer' }),
      r && state.phase !== 'final' ? h('span', { class: 'pill' }, `Round ${r.index + 1}/${r.total}`) : h('span', { class: 'pill' }, `Room ${state.code}`),
      h('span', { class: 'pill' }, `${state.me?.score ?? 0} pts`)
    );
  }

  function hero(emoji, title, sub, ...extra) {
    return h('div', { class: 'p-hero' },
      h('div', { class: 'big-emoji' }, emoji),
      h('h1', { style: 'font-size:2rem' }, title),
      sub ? h('p', { class: 'muted', style: 'font-size:1.1rem;margin:0' }, sub) : null,
      ...extra
    );
  }

  /** "Who's in" chips, refreshed in place (see paintStatus). */
  function statusRow(flag) {
    return h('div', { class: 'status-chips', id: 'status', 'data-flag': flag });
  }
  function paintStatus() {
    const el = document.getElementById('status');
    if (!el || !state) return;
    const flag = el.dataset.flag;
    el.replaceChildren(...state.players.filter((p) => p.connected).map((p) =>
      h('span', { class: `chip${p[flag] ? ' done' : ''}` }, `${p.avatar} ${p.name}${p[flag] ? ' ✓' : ''}`)));
  }

  /** Host-only buttons. */
  function hostBar(...buttons) {
    if (!state.isHost) return null;
    return h('div', { class: 'host-bar' }, h('span', { class: 'host-tag' }, 'Host controls'), ...buttons);
  }

  // ---------- Landing: join or create ----------

  function renderLanding(error) {
    screenKey = 'landing';
    const invited = !!params.get('room'); // came from a QR code / invite link: joining is the main action
    const name = h('input', { class: 'input', maxlength: '16', autocomplete: 'nickname', placeholder: 'Your name', value: session?.name || '' });
    const code = h('input', { class: 'input code', maxlength: '4', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'ABCD', value: params.get('room') || '' });
    const err = h('div', { class: 'error' }, error || '');
    let busy = false;

    async function go(event, payload) {
      if (busy) return;
      if (!name.value.trim()) { err.textContent = 'Type your name first.'; name.focus(); return; }
      busy = true;
      err.textContent = '';
      const res = await act(event, { name: name.value, ...payload });
      busy = false;
      if (!res.ok) { err.textContent = res.error || 'Something went wrong.'; return; }
      session = { code: res.code, playerId: res.playerId, name: res.name };
      save(STORE, session);
    }

    app.replaceChildren(h('div', { class: 'p-hero' },
      logo('4.2rem'),
      h('p', { class: 'muted', style: 'margin:0' }, 'The party game that makes you a sharper speaker.'),
      h('div', { class: 'field' }, h('label', {}, 'Your name'), name),
      h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); go('player:join', { code: code.value }); } },
        h('h2', { class: 'choice-title' }, 'Join a game'),
        h('div', { class: 'field' }, h('label', {}, 'Room code'), code),
        h('button', { class: 'btn block', type: 'submit' }, 'Join game')
      ),
      h('div', { class: 'or' }, h('span', {}, 'or')),
      h('div', { class: 'stack' },
        h('h2', { class: 'choice-title' }, 'Host a game'),
        h('button', { class: `btn block ${invited ? 'ghost' : 'alt'}`, type: 'button', onclick: () => go('player:create') }, 'Create a room'),
        h('p', { class: 'muted', style: 'margin:0;font-size:.9rem' }, "You'll play too, and you get the Start and Next buttons.")
      ),
      err
    ));
    name.focus();
  }

  // ---------- Lobby ----------

  function joinUrl() {
    if (info.publicUrl) return `${info.publicUrl.replace(/\/$/, '')}/?room=${state.code}`;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const base = local && info.lanUrls?.[0] ? info.lanUrls[0] : location.origin;
    return `${base}/?room=${state.code}`;
  }

  function lobby() {
    const s = state;
    const connected = s.players.filter((p) => p.connected);
    const need = Math.max(0, s.minPlayers - connected.length);
    const url = joinUrl();

    const share = async () => {
      try {
        if (navigator.share) await navigator.share({ title: 'Join my Say Less game', text: `Room code: ${s.code}`, url });
        else { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
      } catch {}
    };

    let settings = null;
    if (s.isHost) {
      const set = (patch) => act('host:settings', { ...s.settings, ...patch });
      const modeBtn = (m, label) => {
        const on = s.settings.modes.includes(m);
        return h('button', { class: on ? 'on' : '', onclick: () => {
          const modes = on ? s.settings.modes.filter((x) => x !== m) : [...s.settings.modes, m];
          if (modes.length) set({ modes });
          else toast('Keep at least one mode.');
        } }, label);
      };
      settings = h('div', { class: 'settings' },
        h('div', { class: 'set-row' }, h('span', {}, 'Modes'),
          h('div', { class: 'seg' }, modeBtn('link', 'Missing Link'), modeBtn('pitch', 'One Line Pitch'))),
        h('div', { class: 'set-row' }, h('span', {}, 'After voting'),
          h('div', { class: 'seg' },
            h('button', { class: s.settings.revealAuthors ? 'on' : '', onclick: () => set({ revealAuthors: true }) }, 'Show who wrote what'),
            h('button', { class: s.settings.revealAuthors ? '' : 'on', onclick: () => set({ revealAuthors: false }) }, 'Stay anonymous')))
      );
    }

    return [
      top(),
      h('div', { class: 'card center lobby-card' },
        h('div', { class: 'muted-dark' }, 'Room code'),
        h('div', { class: 'room-code' }, s.code),
        h('div', { class: 'qr' }, h('img', { src: `/api/qr?text=${encodeURIComponent(url)}`, alt: `QR code to join room ${s.code}` })),
        h('div', { class: 'muted-dark', style: 'font-size:.9rem' }, 'Friends scan this, or open the site and type the code.'),
        h('button', { class: 'btn block share-btn', onclick: share }, 'Share invite link')
      ),
      h('div', { class: 'row' },
        h('h2', {}, `Players (${connected.length})`),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted' }, need ? `Need ${need} more` : 'Ready!')
      ),
      h('div', { class: 'player-list' }, s.players.map((p) =>
        h('div', { class: `player-row${p.connected ? '' : ' off'}` },
          h('span', { class: 'em' }, p.avatar),
          h('span', { class: 'nm' }, p.name, p.id === s.me?.id ? ' (you)' : ''),
          p.isHost ? h('span', { class: 'host-tag' }, 'Host') : null))),
      settings,
      s.isHost
        ? h('button', { class: 'btn block', disabled: need > 0, onclick: () => act('host:start') },
            need ? `Waiting for ${need} more player${need === 1 ? '' : 's'}…` : 'Start the game')
        : h('p', { class: 'muted center' }, `Waiting for ${s.hostName || 'the host'} to start the game…`),
      h('button', { class: 'linkish', onclick: () => { if (confirm('Leave this room?')) leave(); } }, 'Leave room'),
    ];
  }

  // ---------- Answer ----------

  function promptCard(r, small) {
    return h('div', { class: 'card prompt-card' },
      h('div', { class: 'row' }, modeChip(r.mode), h('span', { class: 'spacer' }), timer(r.deadline)),
      r.prompt.parts
        ? h('div', { class: 'link-pair' }, h('div', { class: 'obj' }, r.prompt.parts[0]), h('div', { class: 'plus' }, '+'), h('div', { class: 'obj' }, r.prompt.parts[1]))
        : h('div', { class: 'prompt', style: small ? 'font-size:1.15rem' : '' }, r.prompt.text)
    );
  }

  function submit() {
    const r = state.round;
    const endEarly = hostBar(h('button', { class: 'btn ghost', onclick: () => act('host:skip') }, 'End answering now'));
    if (r.submitted) {
      return [top(), promptCard(r), hero('🔒', 'Locked in!', 'Waiting for everyone else…'), statusRow('submitted'), endEarly];
    }
    const max = r.mode.maxWords;
    const ta = h('textarea', { class: 'input', maxlength: '600', placeholder: r.mode.id === 'link' ? 'How are these two connected?' : 'One sentence. Twenty words, max.' });
    const count = h('div', { class: 'counter' }, `0/${max} words`);
    const err = h('div', { class: 'error' });
    const btn = h('button', { class: 'btn block', disabled: true }, 'Lock it in');
    ta.addEventListener('input', () => {
      const n = wordCount(ta.value);
      count.textContent = `${n}/${max} words`;
      count.classList.toggle('over', n > max);
      btn.disabled = n === 0 || n > max;
    });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const res = await act('player:submit', { text: ta.value });
      if (!res.ok) { err.textContent = res.error; btn.disabled = false; }
    });
    setTimeout(() => ta.focus(), 50);
    return [top(), promptCard(r), ta, count, err, btn, statusRow('submitted'), endEarly];
  }

  // ---------- Vote ----------

  function vote() {
    const r = state.round;
    const cats = r.mode.categories.map((c) =>
      h('div', { class: 'vote-cat' },
        h('h3', {}, c.label),
        r.answers.map((a) => a.mine
          ? h('div', { class: 'vote-opt mine' },
              h('span', { class: 'em' }, a.emoji),
              h('span', {}, h('div', { class: 'who' }, `${a.alias} · yours`), h('div', {}, a.text)))
          : h('button', {
              class: `vote-opt${r.myVotes[c.id] === a.sid ? ' picked' : ''}`,
              'data-cat': c.id,
              'data-sid': a.sid,
              onclick: () => act('player:vote', { category: c.id, sid: a.sid }),
            },
              h('span', { class: 'em' }, a.emoji),
              h('span', {}, h('div', { class: 'who' }, a.alias), h('div', {}, a.text))))
      )
    );
    return [
      top(),
      promptCard(r, true),
      h('h2', { id: 'vote-title' }, 'Vote!'),
      h('p', { class: 'muted', id: 'vote-sub', style: 'margin:0' }, "Tap your favourite. Answers are anonymous, and you can't vote for your own."),
      ...cats,
      statusRow('voted'),
      hostBar(h('button', { class: 'btn ghost', onclick: () => act('host:skip') }, 'End voting now')),
    ];
  }

  function paintVotes() {
    const r = state.round;
    document.querySelectorAll('.vote-opt[data-cat]').forEach((b) => b.classList.toggle('picked', r.myVotes[b.dataset.cat] === b.dataset.sid));
    const done = r.mode.categories.every((c) => r.myVotes[c.id]);
    const t = document.getElementById('vote-title');
    const sub = document.getElementById('vote-sub');
    if (t) t.textContent = done ? 'Votes in ✓' : 'Vote!';
    if (sub) sub.textContent = done ? 'You can still change your mind until time runs out.' : "Tap your favourite. Answers are anonymous, and you can't vote for your own.";
  }

  // ---------- Results ----------

  function scoreboard() {
    return h('div', { class: 'scoreboard' }, h('h3', {}, 'Scores'),
      state.leaderboard.map((p, i) => h('div', { class: `score-row${p.id === state.me?.id ? ' me-row' : ''}` },
        h('span', {}, `${i + 1}.`), h('span', {}, p.avatar), h('span', {}, p.name), h('span', { class: 'sc' }, p.score))));
  }

  function results() {
    const r = state.round;
    const res = r.results || { entries: [] };
    const answers = Object.fromEntries(r.answers.map((a) => [a.sid, a]));
    const entries = [...res.entries].sort((a, b) => b.points - a.points);
    const mine = res.entries.find((e) => e.mine);
    const last = r.index + 1 >= r.total;
    return [
      top(),
      h('div', { class: 'center' },
        h('div', { class: 'points-big' }, `+${mine?.points || 0}`),
        h('p', { class: 'muted', style: 'margin:4px 0 0' }, mine ? `${mine.voteCount} vote${mine.voteCount === 1 ? '' : 's'} for your answer` : "You didn't answer this round.")),
      entries.length ? null : hero('🤷', 'Not enough answers to vote on', null),
      h('div', { class: 'stack' }, entries.map((e) => {
        const a = answers[e.sid] || {};
        const winLabels = e.wins.map((w) => r.mode.categories.find((c) => c.id === w)?.label);
        return h('div', { class: `card result-card${e.wins.length ? ' win' : ''}` },
          h('div', { class: 'pts' }, `+${e.points}`),
          h('div', { class: 'who' }, h('span', { class: 'em' }, a.emoji), a.alias, e.mine ? ' · yours' : ''),
          h('div', { class: 'txt' }, a.text),
          h('div', { class: 'badges' },
            winLabels.map((l) => h('span', { class: 'badge' }, `🏆 ${l}`)),
            h('span', { class: 'badge mint' }, `${e.voteCount} vote${e.voteCount === 1 ? '' : 's'}`)),
          e.author ? h('div', { class: 'author' }, `${e.author.avatar} ${e.author.name}`) : null);
      })),
      r.tip ? h('div', { class: 'tip' }, h('b', {}, "Coach's tip"), r.tip) : null,
      scoreboard(),
      state.isHost
        ? hostBar(h('button', { class: 'btn', onclick: () => act('host:next') }, last ? 'See final scores' : 'Next round ▶'))
        : h('p', { class: 'muted center' }, `Waiting for ${state.hostName || 'the host'} to continue…`),
    ];
  }

  // ---------- Final ----------

  function final() {
    const lb = state.leaderboard;
    const medal = ['🥇', '🥈', '🥉'][state.rank - 1] || '🎉';
    return [
      top(),
      hero(medal, state.rank === 1 ? 'You won!' : `You finished #${state.rank}`, lb[0] ? `${lb[0].name} wins with ${lb[0].score} points.` : null),
      scoreboard(),
      state.isHost
        ? hostBar(h('button', { class: 'btn', onclick: () => act('host:playAgain') }, 'Play again'))
        : h('p', { class: 'muted center' }, `${state.hostName || 'The host'} can start another game.`),
      h('button', { class: 'linkish', onclick: leave }, 'Leave room'),
    ];
  }
})();
