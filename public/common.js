// Small helpers shared by the host and phone screens.
window.SL = (() => {
  /** Build a DOM element. Text children are always inserted as text, never HTML. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // The server stamps every state with its clock so countdowns agree across devices.
  let offset = 0;
  const setServerNow = (t) => { if (t) offset = t - Date.now(); };
  const serverNow = () => Date.now() + offset;
  const secsLeft = (deadline) => (deadline ? Math.max(0, Math.ceil((deadline - serverNow()) / 1000)) : null);
  const wordCount = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

  /** Countdown text that keeps itself up to date. */
  function timer(deadline, cls = 'pill timer') {
    const el = h('span', { class: cls, 'data-deadline': deadline || '' });
    paintTimer(el);
    return el;
  }
  function paintTimer(el) {
    const left = secsLeft(Number(el.dataset.deadline));
    el.textContent = left == null ? '' : `${left}s`;
    el.classList.toggle('low', left != null && left <= 10);
  }
  setInterval(() => document.querySelectorAll('[data-deadline]').forEach(paintTimer), 250);

  function logo(size) {
    return h('div', { class: 'logo', style: size ? `font-size:${size}` : '' }, 'Say ', h('span', {}, 'Less'), h('span', { class: 'dot' }, '.'));
  }

  function modeChip(mode) {
    return h('span', { class: `mode-chip mode-${mode.id}` }, mode.name);
  }

  /** Transcript with filler words highlighted. */
  function transcriptEl(segments, fallback) {
    if (!segments) return h('span', {}, fallback || '');
    return h('span', {}, segments.map((s) => (s.t === 'filler' ? h('span', { class: 'filler' }, s.s) : s.s)));
  }

  function load(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
  function save(key, v) { try { v == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(v)); } catch {} }

  return { h, setServerNow, serverNow, secsLeft, wordCount, timer, logo, modeChip, transcriptEl, load, save };
})();
