// Optional site-wide password. Set GAME_PASSWORD to turn it on; leave it unset for open local play.
// Each device enters the password once and gets a 30-day cookie. The same cookie is checked
// on the Socket.io connection, so nobody can join a room without it.
const crypto = require('crypto');

const PASSWORD = process.env.GAME_PASSWORD || '';
const COOKIE = 'sl_auth';
const MAX_AGE_SECS = 30 * 24 * 60 * 60;
// Derived from the password (plus an optional secret), so changing the password signs everyone out.
const TOKEN = PASSWORD
  ? crypto.createHmac('sha256', process.env.SESSION_SECRET || 'say-less').update(PASSWORD).digest('hex')
  : '';

const enabled = () => !!PASSWORD;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function isAuthed(cookieHeader) {
  if (!enabled()) return true;
  const v = cookieValue(cookieHeader, COOKIE);
  return !!v && safeEqual(v, TOKEN);
}

/** Only allow redirects back to a path on this site. */
function safeNext(next) {
  const n = String(next || '/');
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/';
}

// Slow down password guessing: 10 tries per IP per 10 minutes.
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  attempts.set(ip, list);
  return list.length >= 10;
}
function recordAttempt(ip) {
  attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);
}
setInterval(() => attempts.clear(), 60 * 60 * 1000).unref();

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loginPage(next, error) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#17112a"><meta name="robots" content="noindex">
<title>Say Less · Password</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
</head><body class="player"><main id="app">
<div class="p-hero">
  <div class="logo" style="font-size:4.2rem">Say <span>Less</span><span class="dot">.</span></div>
  <p class="muted" style="margin:0">This game is private. Enter the password to play.</p>
  <form class="stack" method="post" action="/login">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <div class="field"><label for="pw">Password</label>
      <input id="pw" class="input" type="password" name="password" autocomplete="current-password" autofocus required></div>
    <div class="error">${error ? escapeHtml(error) : ''}</div>
    <button class="btn block" type="submit">Let me in</button>
  </form>
</div></main></body></html>`;
}

/** Express routes + gate. Call before serving any other route. */
function install(app) {
  if (!enabled()) return;
  const express = require('express');

  app.get('/login', (req, res) => {
    if (isAuthed(req.headers.cookie)) return res.redirect(safeNext(req.query.next));
    res.type('html').send(loginPage(safeNext(req.query.next), req.query.error === '1' ? 'Wrong password — try again.' : req.query.error === '2' ? 'Too many tries. Wait a few minutes.' : ''));
  });

  app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const next = safeNext(req.body?.next);
    const ip = req.ip;
    if (tooManyAttempts(ip)) return res.redirect(`/login?error=2&next=${encodeURIComponent(next)}`);
    if (!safeEqual(req.body?.password || '', PASSWORD)) {
      recordAttempt(ip);
      return res.redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
    }
    res.setHeader('Set-Cookie', `${COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECS}${req.secure ? '; Secure' : ''}`);
    res.redirect(next);
  });

  // Everything else needs the cookie. The stylesheet stays public so the login page is styled.
  app.use((req, res, next) => {
    if (req.path === '/style.css' || isAuthed(req.headers.cookie)) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io')) return res.status(401).end();
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  });
}

module.exports = { install, isAuthed, enabled };
