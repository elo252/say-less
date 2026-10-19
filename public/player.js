// Phone screen: join, answer, record, vote.
(() => {
  const { h, setServerNow, secsLeft, wordCount, timer, logo, modeChip, load, save } = SL;
  const app = document.getElementById('app');
  const socket = io();
  // The site password is on and this device hasn't entered it (or it changed): go to the login page.
  socket.on('connect_error', async () => {
    try {
      const r = await fetch('/api/info', { cache: 'no-store' });
      if (r.status === 401) location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    } catch {}
  });
  const STORE = 'sayless.player';
  const params = new URLSearchParams(location.search);

  let state = null;
  let screenKey = '';
  let session = load(STORE); // { code, playerId, name }
  let rec = null; // active recording (see startRecording)
  let busy = false;

  // ---------- Connection ----------

  socket.on('connect', () => {
    const urlCode = (params.get('room') || '').toUpperCase();
    if (session && (!urlCode || urlCode === session.code)) {
      socket.emit('player:join', { code: session.code, playerId: session.playerId, name: session.name }, (res) => {
        if (!res.ok) { session = null; save(STORE, null); renderJoin(res.error); }
      });
    } else if (!state) {
      renderJoin();
    }
  });

  socket.on('disconnect', () => {
    if (state) showToast('Reconnecting…');
  });

  socket.on('player:replaced', () => {
    state = null;
    screenKey = '';
    app.replaceChildren(hero('📱', 'You joined from another tab', 'This screen is now inactive.'));
  });

  socket.on('player:state', (s) => {
    setServerNow(s.serverNow);
    state = s;
    render();
  });

  // ---------- Rendering ----------

  function keyFor(s) {
    const r = s.round;
    switch (s.phase) {
      case 'lobby': return `lobby|${s.playerCount}`;
      case 'submit': return `submit|${r.index}|${r.submitted}`;
      case 'vote': return `vote|${r.index}|${r.options.length}`;
      case 'results': return `results|${r.index}|${s.me?.score}`;
      case 'final': return `final|${s.rank}|${s.me?.score}`;
      default: return `${s.phase}|${r?.index}`;
    }
  }

  function render() {
    const key = keyFor(state);
    if (key === screenKey) {
      if (state.phase === 'vote') paintVotes(); // update ticks in place so the list doesn't jump
      return;
    }
    // Never wipe a recording or a half-typed answer because someone else locked in.
    if (state.phase === 'submit' && screenKey.startsWith(`submit|${state.round.index}|false`) && !state.round.submitted) return;
    screenKey = key;
    if (rec && state.phase !== 'submit') stopRecording(true);
    const screens = { lobby, submit, processing, reveal, vote, results, final };
    app.replaceChildren(...[].concat((screens[state.phase] || lobby)()));
  }

  function top() {
    const r = state.round;
    return h('div', { class: 'p-top' },
      h('span', { style: 'font-size:1.6rem' }, state.me?.avatar || ''),
      h('span', { class: 'me' }, state.me?.name || ''),
      h('span', { class: 'spacer' }),
      r && state.phase !== 'final' ? h('span', { class: 'pill' }, `Round ${r.index + 1}/${r.total}`) : null,
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

  function showToast(msg) {
    const t = h('div', { class: 'pill', style: 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#000;color:#fff;z-index:9' }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 2500);
  }

  // ---------- Join ----------

  function renderJoin(error) {
    screenKey = 'join';
    const code = h('input', { class: 'input code', maxlength: '4', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'ABCD', value: params.get('room') || session?.code || '' });
    const name = h('input', { class: 'input', maxlength: '16', autocomplete: 'nickname', placeholder: 'Your name', value: session?.name || '' });
    const err = h('div', { class: 'error' }, error || '');
    const btn = h('button', { class: 'btn block', type: 'submit' }, 'Join game');
    const form = h('form', { class: 'stack', onsubmit: (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      btn.disabled = true;
      socket.emit('player:join', { code: code.value, name: name.value }, (res) => {
        busy = false;
        btn.disabled = false;
        if (!res.ok) { err.textContent = res.error; return; }
        session = { code: res.code, playerId: res.playerId, name: res.name };
        save(STORE, session);
      });
    } },
      h('div', { class: 'field' }, h('label', {}, 'Room code'), code),
      h('div', { class: 'field' }, h('label', {}, 'Name'), name),
      err,
      btn
    );
    const invited = !!params.get('room'); // came from a QR code / invite link: joining is the main action
    app.replaceChildren(h('div', { class: 'p-hero' },
      logo('4.2rem'),
      h('p', { class: 'muted', style: 'margin:0' }, 'The party game that makes you a sharper speaker.'),
      h('h2', { class: 'choice-title' }, 'Join a game'),
      form,
      h('div', { class: 'or' }, h('span', {}, 'or')),
      h('h2', { class: 'choice-title' }, 'Host a game'),
      h('a', { class: `btn block ${invited ? 'ghost' : 'alt'}`, href: '/host', style: 'text-decoration:none;display:block' }, 'Create a room'),
      h('p', { class: 'muted', style: 'margin:0;font-size:.9rem' }, 'Opens the host screen. Best on a laptop or TV everyone can see.')
    ));
    (code.value ? name : code).focus();
  }

  // ---------- Phases ----------

  function lobby() {
    return [top(), hero(state.me?.avatar || '🎉', "You're in!", 'Watch the big screen. The host will start soon.',
      h('div', { class: 'pill', style: 'align-self:center' }, `${state.playerCount} player${state.playerCount === 1 ? '' : 's'} here`),
      state.playerCount < state.minPlayers ? h('p', { class: 'muted' }, `Need ${state.minPlayers - state.playerCount} more to start.`) : null
    )];
  }

  function promptCard(r) {
    return h('div', { class: 'card prompt-card' },
      h('div', { class: 'row' }, modeChip(r.mode), h('span', { class: 'spacer' }), timer(r.deadline)),
      r.prompt.parts
        ? h('div', { class: 'link-pair' }, h('div', { class: 'obj' }, r.prompt.parts[0]), h('div', { class: 'plus' }, '+'), h('div', { class: 'obj' }, r.prompt.parts[1]))
        : h('div', { class: 'prompt' }, r.prompt.text)
    );
  }

  function submit() {
    const r = state.round;
    if (r.submitted) return [top(), hero('🔒', 'Locked in!', 'Waiting for everyone else…')];
    const body = r.mode.input === 'voice' ? voiceInput(r) : textInput(r, r.mode.maxWords);
    return [top(), promptCard(r), body];
  }

  function textInput(r, maxWords, { typedFallback = false } = {}) {
    const placeholder = {
      link: 'How are these two connected?',
      pitch: 'One sentence. Twenty words, max.',
      ums: 'Type your rant instead (no fluency points)…',
    }[r.mode.id];
    const ta = h('textarea', { class: 'input', placeholder, maxlength: '600' });
    const count = h('div', { class: 'counter' }, `0/${maxWords} words`);
    const err = h('div', { class: 'error' });
    const btn = h('button', { class: 'btn block', disabled: true }, 'Lock it in');
    ta.addEventListener('input', () => {
      const n = wordCount(ta.value);
      count.textContent = `${n}/${maxWords} words`;
      count.classList.toggle('over', n > maxWords);
      btn.disabled = n === 0 || n > maxWords;
    });
    btn.addEventListener('click', () => {
      btn.disabled = true;
      socket.emit('player:submit', { text: ta.value, typed: typedFallback }, (res) => {
        if (!res.ok) { err.textContent = res.error; btn.disabled = false; }
      });
    });
    setTimeout(() => ta.focus(), 50);
    return h('div', { class: 'stack' }, ta, count, err, btn);
  }

  // ---------- Voice recording ----------

  function voiceInput(r) {
    const wrap = h('div', { class: 'rec-wrap' });
    const err = h('div', { class: 'error center' });
    const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

    const idle = () => {
      wrap.replaceChildren(
        h('button', { class: 'rec-btn', onclick: () => startRecording(r, wrap, err, review) }, 'Tap to talk'),
        h('p', { class: 'muted center', style: 'margin:0' }, `Talk for ${r.mode.recordMinSecs}–${r.mode.recordMaxSecs} seconds. Your voice will be disguised.`),
        !canRecord ? h('div', { class: 'warn' }, window.isSecureContext ? "This browser can't record audio." : 'The mic only works over a secure (https) link. Ask the host for the https link, or type your answer below.') : null,
        err,
        h('button', { class: 'linkish', onclick: () => wrap.replaceChildren(textInput(r, r.mode.maxWords, { typedFallback: true })) }, "Can't talk right now? Type it instead")
      );
    };

    const review = (clip) => {
      const audio = h('audio', { controls: true, src: URL.createObjectURL(clip.blob), style: 'width:100%' });
      const send = h('button', { class: 'btn block' }, `Send it (${Math.round(clip.durationSec)}s)`);
      const redo = h('button', { class: 'btn ghost block' }, 'Redo');
      send.addEventListener('click', () => sendClip(clip, send, err));
      redo.addEventListener('click', idle);
      const tooShort = clip.durationSec < r.mode.recordMinSecs;
      wrap.replaceChildren(
        h('div', { class: 'live-um' }, 'Ums spotted: ', h('b', {}, String(Fillers.analyze(clip.transcript).count))),
        audio,
        tooShort ? h('div', { class: 'error center' }, `That was under ${r.mode.recordMinSecs}s — you'll earn fewer fluency points.`) : null,
        err,
        send,
        secsLeft(r.deadline) > 8 ? redo : null
      );
    };

    if (rec?.clip) review(rec.clip);
    else idle();
    return wrap;
  }

  async function startRecording(r, wrap, err, onDone) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      err.textContent = 'Microphone blocked. Allow mic access in your browser settings, or type your answer.';
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec = { mr, stream, chunks, startedAt: performance.now(), finals: [], interim: '', onDone, clip: null };
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      const durationSec = (performance.now() - rec.startedAt) / 1000;
      const blob = new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' });
      stream.getTracks().forEach((t) => t.stop());
      const clip = { blob, mime: blob.type, durationSec, transcript: transcriptText() };
      rec.clip = clip;
      clearInterval(rec.tick);
      if (rec.autoSend) sendClip(clip);
      else rec.onDone(clip);
    };

    // Free filler counting via the phone's own speech recognition (Chrome, Safari).
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      try {
        const sr = new SR();
        sr.continuous = true;
        sr.interimResults = true;
        sr.lang = 'en-US';
        sr.onresult = (e) => {
          let interim = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            if (res.isFinal) rec.finals.push(res[0].transcript.trim());
            else interim += res[0].transcript;
          }
          rec.interim = interim;
          paintLive();
        };
        sr.onend = () => { if (rec && rec.mr.state === 'recording') try { sr.start(); } catch {} };
        sr.start();
        rec.sr = sr;
      } catch { /* recognition is a bonus, not required */ }
    }

    mr.start(250);
    const timeEl = h('div', { class: 'rec-time' }, '0s');
    const umEl = h('b', {}, '0');
    const live = h('div', { class: 'live-transcript' });
    rec.paint = { timeEl, umEl, live };
    wrap.replaceChildren(
      h('button', { class: 'rec-btn live', onclick: () => stopRecording() }, 'Tap to stop'),
      timeEl,
      rec.sr ? h('div', { class: 'live-um' }, 'Ums: ', umEl) : h('div', { class: 'muted' }, 'Recording…'),
      live
    );
    rec.tick = setInterval(() => {
      const el = (performance.now() - rec.startedAt) / 1000;
      timeEl.textContent = `${Math.floor(el)}s / ${r.mode.recordMaxSecs}s`;
      const left = secsLeft(r.deadline);
      if (el >= r.mode.recordMaxSecs) stopRecording();
      else if (left != null && left <= 1) { rec.autoSend = true; stopRecording(); } // round is ending: send what we have
    }, 200);
  }

  function transcriptText() {
    return rec ? [...rec.finals, rec.interim].join(' ').replace(/\s+/g, ' ').trim() : '';
  }

  function paintLive() {
    if (!rec?.paint) return;
    const text = transcriptText();
    rec.paint.umEl.textContent = String(Fillers.analyze(text).count);
    rec.paint.live.textContent = text.slice(-140);
  }

  function stopRecording(discard = false) {
    if (!rec) return;
    try { rec.sr?.stop(); } catch {}
    if (discard) {
      clearInterval(rec.tick);
      rec.mr.onstop = null;
      try { rec.mr.state !== 'inactive' && rec.mr.stop(); } catch {}
      rec.stream.getTracks().forEach((t) => t.stop());
      rec = null;
      return;
    }
    if (rec.mr.state !== 'inactive') rec.mr.stop();
  }

  async function sendClip(clip, btn, err) {
    if (rec) rec.sending = true;
    if (btn) btn.disabled = true;
    const audio = await clip.blob.arrayBuffer();
    socket.emit('player:submit', { audio, mime: clip.mime, durationSec: clip.durationSec, browserTranscript: clip.transcript }, (res) => {
      if (res.ok) { rec = null; return; }
      if (rec) rec.sending = false;
      if (err) err.textContent = res.error;
      if (btn) btn.disabled = false;
    });
  }

  // A recorded-but-unsent clip goes in automatically just before the round closes.
  setInterval(() => {
    if (state?.phase !== 'submit' || !rec?.clip || rec.sending) return;
    const left = secsLeft(state.round.deadline);
    if (left != null && left <= 1) sendClip(rec.clip);
  }, 300);

  // ---------- After submitting ----------

  function processing() {
    return [top(), hero('🤖', 'Counting the ums…', 'The robot is listening very carefully.', h('div', { class: 'spinner' }))];
  }

  function reveal() {
    return [top(), hero('👀', 'Eyes on the big screen', 'Answers are being revealed — anonymously.')];
  }

  function vote() {
    const r = state.round;
    if (!r.options.length) return [top(), hero('🗳️', 'Sit this one out', 'There was nothing for you to vote on.')];
    const cats = r.mode.categories.map((c) =>
      h('div', { class: 'vote-cat' },
        h('h3', {}, c.label),
        r.options.map((o) =>
          h('button', {
            class: `vote-opt${r.myVotes[c.id] === o.sid ? ' picked' : ''}`,
            'data-cat': c.id,
            'data-sid': o.sid,
            onclick: () => socket.emit('player:vote', { category: c.id, sid: o.sid }, (res) => { if (!res.ok) showToast(res.error); }),
          },
            h('span', { class: 'em' }, o.emoji),
            h('span', {}, h('div', { class: 'who' }, o.alias), h('div', {}, o.preview))
          )
        )
      )
    );
    const done = r.mode.categories.every((c) => r.myVotes[c.id]);
    return [
      top(),
      h('div', { class: 'row' }, h('h2', { id: 'vote-title' }, done ? 'Votes in ✓' : 'Vote!'), h('span', { class: 'spacer' }), timer(r.deadline)),
      h('p', { class: 'muted', id: 'vote-sub', style: 'margin:0' }, done ? 'You can still change your mind until time runs out.' : "Tap your favourite. You can't vote for your own."),
      ...cats,
    ];
  }

  function paintVotes() {
    const r = state.round;
    document.querySelectorAll('.vote-opt').forEach((b) => b.classList.toggle('picked', r.myVotes[b.dataset.cat] === b.dataset.sid));
    const done = r.mode.categories.every((c) => r.myVotes[c.id]);
    const t = document.getElementById('vote-title');
    const sub = document.getElementById('vote-sub');
    if (t) t.textContent = done ? 'Votes in ✓' : 'Vote!';
    if (sub) sub.textContent = done ? 'You can still change your mind until time runs out.' : "Tap your favourite. You can't vote for your own.";
  }

  function results() {
    const r = state.round;
    const mine = r.results?.mine;
    const pts = mine?.points || 0;
    const lines = [];
    if (mine) {
      if (mine.voteCount) lines.push(`${mine.voteCount} vote${mine.voteCount === 1 ? '' : 's'}`);
      if (mine.wins?.length) lines.push(`🏆 won ${mine.wins.map((w) => r.mode.categories.find((c) => c.id === w)?.label).join(' + ')}`);
    }
    const sub = r.mySub;
    if (sub?.kind === 'voice') {
      if (sub.fillers == null) lines.push('Fluency not measured this time');
      else if (sub.bust) lines.push(`💥 BUSTED — ${sub.fillers} fillers (${sub.perMin}/min)`);
      else lines.push(`${sub.fillers} filler${sub.fillers === 1 ? '' : 's'} → +${sub.fluencyPoints} fluency`);
    }
    return [
      top(),
      h('div', { class: 'p-hero' },
        h('div', { class: 'points-big' }, `+${pts}`),
        h('p', { style: 'margin:0;font-size:1.1rem' }, mine ? lines.join(' · ') || 'No votes this time.' : "You didn't answer this round."),
        h('div', { class: 'pill', style: 'align-self:center' }, `#${state.rank} of ${state.leaderboard?.length || state.playerCount} · ${state.me.score} pts`),
        r.tip ? h('div', { class: 'tip' }, h('b', {}, "Coach's tip"), r.tip) : null
      ),
    ];
  }

  function final() {
    const medal = ['🥇', '🥈', '🥉'][state.rank - 1] || '🎉';
    return [
      top(),
      hero(medal, state.rank === 1 ? 'You won!' : `You finished #${state.rank}`, `${state.me.score} points. Thanks for playing!`),
    ];
  }
})();
