'use strict';

// Minimal in-memory sessions. Nothing is ever written to disk, and ending a
// session (sign out, closing the browser tab, idle timeout) deletes
// everything attached to it -- including its request log.
//
// Two credentials per session:
//  - `sid`: an httpOnly, SameSite=Strict browser-session cookie for the
//    browser UI and its API (/app, /api/*).
//  - `token`: a path segment in every proxied URL (/p/<token>/...). Proxied
//    pages run in sandboxed frames with an opaque origin, so they carry no
//    cookies at all; the token is what authorises their requests. It's
//    bound to the IP that signed in, so a token that leaks (e.g. in a
//    Referer) is useless to anyone else, and it dies with the session.

const crypto = require('crypto');

const IDLE_MS = 30 * 60 * 1000; // end after 30 min without activity
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // and after 12 h regardless
const MAX_LOG_ENTRIES = 200;
const COOKIE = 'nb_sid';

const sessions = new Map(); // sid -> session
const byToken = new Map(); // token -> session

function randomId() {
  return crypto.randomBytes(24).toString('base64url');
}

function create(ip) {
  const now = Date.now();
  const s = { sid: randomId(), token: randomId(), ip, created: now, lastSeen: now, logs: [] };
  sessions.set(s.sid, s);
  byToken.set(s.token, s);
  return s;
}

function destroy(s) {
  if (!s) return;
  s.logs.length = 0;
  sessions.delete(s.sid);
  byToken.delete(s.token);
}

function alive(s) {
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastSeen > IDLE_MS || now - s.created > MAX_AGE_MS) {
    destroy(s);
    return null;
  }
  s.lastSeen = now;
  return s;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx !== -1 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function fromCookie(req) {
  const sid = readCookie(req, COOKIE);
  return sid ? alive(sessions.get(sid)) : null;
}

function fromToken(token, ip) {
  const s = alive(byToken.get(token));
  if (!s || s.ip !== ip) return null;
  return s;
}

function setCookie(req, res, s) {
  // No Max-Age/Expires: a browser-session cookie, gone when the browser
  // closes even if the close beacon never arrives.
  res.cookie(COOKIE, s.sid, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
}

function clearCookie(req, res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
}

function log(s, entry) {
  if (!s) return;
  s.logs.unshift({ time: new Date().toISOString(), ...entry });
  if (s.logs.length > MAX_LOG_ENTRIES) s.logs.length = MAX_LOG_ENTRIES;
}

setInterval(() => {
  for (const s of sessions.values()) alive(s);
}, 60 * 1000).unref();

module.exports = { create, destroy, fromCookie, fromToken, setCookie, clearCookie, log };
