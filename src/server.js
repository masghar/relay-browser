'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const { requireAuth, login, endSession, sessionInfo, CLEAR_SITE_DATA } = require('./auth');
const { handleProxyRequest, answerPreflight, setCors } = require('./proxy');
const { toProxyUrl, targetFromReferer, resolveStray } = require('./proxyUrl');
const session = require('./session');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');

// The hosting platform terminates TLS in front of the app and forwards over
// HTTP, so trust the proxy for req.protocol / req.ip / secure cookies.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.set('etag', false);

// Nothing this app serves may be written to the browser's disk cache.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Headers for this app's own pages (the browser UI and sign-in). Proxied
// pages get their own policy in proxy.js.
function appPageHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
}

// Stray requests from proxied pages. A proxied site's JS that asks for a
// root-relative path (`/api/foo`) resolves against *our* origin, not the
// site's; the client shim catches most of these, and this catches the rest
// (dynamic import(), CSS url(), plain link navigations). The Referer names
// the proxied page (and session token) that made the request, so it can
// be redirected to the same path on that page's site. 307 keeps the method
// and body for POSTs. This runs before our own routes because a site's
// `/api/...` or `/login` must never reach this app's handlers.
app.use((req, res, next) => {
  if (req.path.startsWith('/p/')) {
    next();
    return;
  }
  const ref = targetFromReferer(req.get('referer'), req.get('host'));
  if (!ref || !session.fromToken(ref.token, req.ip)) {
    next();
    return;
  }
  if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
    answerPreflight(req, res);
    return;
  }
  setCors(res);
  res.redirect(307, toProxyUrl(resolveStray(req.originalUrl, ref.url), ref.token));
});

// --- Sign-in (unauthenticated) --------------------------------------------------

// Loading the sign-in page wipes everything this origin ever stored in the
// browser, as a backstop in case the last session's close beacon never
// arrived (browser crash, network drop).
app.get('/login.html', (req, res) => res.redirect(301, '/login'));
app.get('/login', appPageHeaders, (req, res) => {
  session.destroy(session.fromCookie(req));
  res.set('Clear-Site-Data', CLEAR_SITE_DATA);
  res.sendFile(path.join(PUBLIC, 'login', 'login.html'));
});
// Icons and the web app manifest. Public: the sign-in page needs them.
app.use('/icons', appPageHeaders, express.static(path.join(PUBLIC, 'icons'), { etag: false, lastModified: false, fallthrough: false }));
app.get('/favicon.ico', (req, res) => res.type('png').sendFile(path.join(PUBLIC, 'icons', 'favicon-32.png')));
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').sendFile(path.join(PUBLIC, 'manifest.webmanifest')));

app.post('/api/login', express.json({ limit: '2kb' }), express.urlencoded({ extended: false, limit: '2kb' }), login);

// Ending a session never needs a valid one -- it just wipes whatever is there.
app.post('/api/logout', endSession);
app.post('/api/close', endSession);

// --- The browser (authenticated) ------------------------------------------------

app.get('/api/session', requireAuth, sessionInfo);
app.get('/api/logs', requireAuth, (req, res) => res.json(req.nbSession.logs));
app.delete('/api/logs', requireAuth, (req, res) => {
  req.nbSession.logs.length = 0;
  res.status(204).end();
});

// All methods: proxied sites POST to their APIs and submit forms. No body
// parser here -- the raw request body is streamed upstream as-is.
// Authorised by the token in the path (see session.js), not the cookie.
app.all('/p/*', handleProxyRequest);

app.use('/app', requireAuth, appPageHeaders, express.static(path.join(PUBLIC, 'app'), { etag: false, lastModified: false }));

app.get('/', (req, res) => {
  res.redirect(session.fromCookie(req) ? '/app/' : '/login');
});

app.use((req, res) => {
  res.status(404).type('text').send('Not found');
});

// Last-resort net: Express only routes here for errors passed to next(err),
// which mainly covers synchronous throws in non-async handlers -- the proxy
// route already guards its own async errors. This exists so a mistake
// anywhere else in the app degrades to a response instead of a crash.
// Only the error's name is logged: messages can contain visited URLs.
app.use((err, req, res, next) => {
  console.error('request error:', err && err.name);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(500).type('text').send('Internal error');
});

// Defense in depth: a promise rejection or exception that somehow still
// escapes all of the above would otherwise take the whole process down,
// dropping every in-flight user, not just the one request that triggered
// it. Logging and continuing is a deliberate trade-off for a small,
// stateless proxy server.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason && reason.name);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err && err.name);
});

app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
  if (!process.env.APP_PASSWORD) {
    console.warn('WARNING: APP_PASSWORD is not set -- sign-in will always fail.');
  }
});
