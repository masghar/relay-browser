'use strict';

// Single shared password (APP_PASSWORD) gating the whole app. See the
// README for why an unauthenticated URL fetcher isn't safe to expose.

const crypto = require('crypto');
const session = require('./session');

// Tells the browser to delete everything this origin stored: cookies,
// localStorage/IndexedDB/cache storage, and the HTTP cache. Sent when a
// session ends and whenever the sign-in page loads, so nothing a proxied
// site managed to leave behind outlives the session.
const CLEAR_SITE_DATA = '"cache", "cookies", "storage"';

// Failed sign-ins: 5 per 15 minutes per IP.
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map(); // ip -> { count, first }

function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > FAILURE_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return f.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > FAILURE_WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
  else f.count += 1;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of failures) if (now - f.first > FAILURE_WINDOW_MS) failures.delete(ip);
}, 60 * 1000).unref();

function passwordMatches(given, expected) {
  // Compare fixed-length digests so neither length nor content leaks
  // through timing.
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
  const s = session.fromCookie(req);
  if (s) {
    req.nbSession = s;
    next();
    return;
  }
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Your session has ended. Sign in again.' });
    return;
  }
  res.redirect('/login');
}

function login(req, res) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    res.status(500).json({ error: 'Sign-in isn’t configured on the server (APP_PASSWORD is not set).' });
    return;
  }
  if (tooManyFailures(req.ip)) {
    res.status(429).json({ error: 'Too many attempts. Wait 15 minutes, then try again.' });
    return;
  }
  const { password } = req.body || {};
  if (typeof password !== 'string' || !passwordMatches(password, expected)) {
    recordFailure(req.ip);
    res.status(401).json({ error: 'That password isn’t right.' });
    return;
  }
  failures.delete(req.ip);
  const s = session.create(req.ip);
  session.setCookie(req, res, s);
  res.json({ ok: true });
}

// Sign out, and the beacon the browser UI sends when its tab closes: both
// end the session and wipe everything, server and browser side.
function endSession(req, res) {
  session.destroy(session.fromCookie(req));
  session.clearCookie(req, res);
  res.set('Clear-Site-Data', CLEAR_SITE_DATA);
  res.status(204).end();
}

function sessionInfo(req, res) {
  res.json({ token: req.nbSession.token });
}

module.exports = { requireAuth, login, endSession, sessionInfo, CLEAR_SITE_DATA };
