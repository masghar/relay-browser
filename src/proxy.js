'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const {
  rewriteHtml,
  rewriteCss,
  rewriteHls,
  rewriteDash,
} = require('./rewrite');
const { toProxyUrl, fromProxyPath, targetFromReferer, stripTrackingParams } = require('./proxyUrl');
const { buildShimTag } = require('./clientShim');
const { isBlocked } = require('./blocklist');
const session = require('./session');

const SHIM_TAG = buildShimTag();

const UPSTREAM_TIMEOUT_MS = 20000;

// Request headers never forwarded upstream. Besides hop-by-hop headers this
// drops any cookie, the X-Forwarded-*/Forwarded headers the hosting
// platform's front proxy adds (they carry the user's real IP -- the target
// must only ever see the server's), and User-Agent Client Hints, which
// exist mostly to fingerprint.
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'cookie',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'accept-encoding', // we set our own, and decode what comes back
  'origin', // rewritten below
  'referer', // rewritten below
  'forwarded',
  'x-real-ip',
  'cdn-loop',
  'dnt',
  'sec-gpc',
]);

// Headers we pass back from the upstream response; everything else --
// Set-Cookie, caching validators, CSP/X-Frame-Options, Referrer-Policy,
// Link preloads -- is dropped.
const PASSTHROUGH_RESPONSE_HEADERS = ['content-type', 'accept-ranges', 'content-disposition'];

function isRedirect(statusCode) {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function buildUpstreamHeaders(req, target) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const h = name.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(h) || h.startsWith('x-forwarded-') || h.startsWith('cf-') || h.startsWith('sec-ch-')) continue;
    headers[h] = value;
  }
  if (!headers['user-agent']) headers['user-agent'] = 'Mozilla/5.0';
  headers['accept-encoding'] = 'gzip, deflate, br';
  // Opt out of tracking/sale wherever sites honour it.
  headers.dnt = '1';
  headers['sec-gpc'] = '1';

  // Make the request look like it came from the target site itself rather
  // than from our origin: many APIs check Origin/Referer.
  const ref = targetFromReferer(req.headers.referer, req.headers.host);
  if (ref) headers.referer = ref.url;
  if (req.headers.origin) {
    headers.origin = ref ? new URL(ref.url).origin : target.origin;
  }
  return headers;
}

/**
 * Make one upstream request (no redirect following -- redirects are handed
 * back to the browser with a proxied Location, so the proxied document's
 * URL always matches the page it's showing, which relative URLs built by
 * the page's JS depend on). Request bodies are streamed through, so POST
 * APIs and form posts work.
 *
 * `signal` aborts the request when the client that asked for it
 * disconnects -- without it, a browser aborting a video seek would leave us
 * fetching upstream data nobody wants any more.
 */
function fetchUpstream(req, targetUrl, signal) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      reject(Object.assign(new Error('invalid target URL'), { statusCode: 400 }));
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      reject(Object.assign(new Error('unsupported protocol'), { statusCode: 400 }));
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const headers = buildUpstreamHeaders(req, parsed);
    const upstreamReq = client.request(
      parsed,
      { method: req.method, headers, timeout: UPSTREAM_TIMEOUT_MS, signal },
      (res) => resolve({ res, finalUrl: parsed.toString() })
    );

    upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('the site took too long to respond')));
    // AbortError from `signal` firing lands here too -- reported the same
    // as any other upstream failure rather than crashing anything.
    upstreamReq.on('error', reject);

    if (req.method === 'GET' || req.method === 'HEAD') upstreamReq.end();
    else req.pipe(upstreamReq);
  });
}

function decodeBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let stream = res;
    const encoding = (res.headers['content-encoding'] || '').toLowerCase();
    try {
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
    } catch (e) {
      reject(e);
      return;
    }
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function contentKind(contentType, finalUrl) {
  const ct = (contentType || '').toLowerCase();
  const path = (() => {
    try {
      return new URL(finalUrl).pathname.toLowerCase();
    } catch (e) {
      return '';
    }
  })();

  if (ct.includes('text/html')) return 'html';
  if (ct.includes('text/css')) return 'css';
  if (ct.includes('mpegurl') || path.endsWith('.m3u8')) return 'hls';
  if (ct.includes('dash+xml') || path.endsWith('.mpd')) return 'dash';
  return 'binary';
}

// --- Headers every proxied response carries -------------------------------

function ourOrigin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// Proxied pages live in opaque-origin sandboxes, so every request they make
// to us is cross-origin: fetch/XHR, module scripts and fonts all need CORS.
// Credentials never travel (the token in the path authorises), so a
// wildcard is correct here.
function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Expose-Headers', '*');
}

function answerPreflight(req, res) {
  setCors(res);
  res.set('Access-Control-Allow-Methods', req.headers['access-control-request-method'] || 'GET, POST');
  if (req.headers['access-control-request-headers']) {
    res.set('Access-Control-Allow-Headers', req.headers['access-control-request-headers']);
  }
  res.set('Access-Control-Max-Age', '600');
  res.status(204).end();
}

// Applied to every proxied HTML document, however it's opened:
//  - `sandbox` (without allow-same-origin) gives it an opaque origin, so it
//    can never read this app, its session, other tabs, or leave cookies or
//    storage in the browser -- even if someone opens a /p/ URL directly.
//  - every fetch the page makes may only go to this server, so a request
//    the rewriting missed can't reach a tracker or reveal the user's IP.
function connectPolicy(req) {
  const self = ourOrigin(req);
  return `default-src ${self} data: blob: 'unsafe-inline' 'unsafe-eval'; form-action ${self}; base-uri ${self}`;
}

// The same connection policy as a <meta> tag inside the document: some
// hosting front ends replace CSP response headers with their own, and a
// meta policy can't be stripped that way (it just can't carry `sandbox`,
// which the iframe attribute and the top-level guard below cover).
function metaPolicyTag(req) {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(connectPolicy(req))}">`;
}

function setDocumentPolicy(req, res) {
  res.set('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-modals allow-pointer-lock allow-presentation; ' + connectPolicy(req));
  // Sandboxed documents are cross-origin to us, and stray requests are
  // routed by their full Referer; the CSP above keeps it from going
  // anywhere but this server.
  res.set('Referrer-Policy', 'unsafe-url');
}

// --- Error pages ------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function errorPage(heading, detail, { script = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(heading)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;
font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fff;color:#1d2330}
@media(prefers-color-scheme:dark){body{background:#202329;color:#e7eaf0}p{color:#9ea6b4!important}}
main{max-width:460px;padding:24px}h1{font-size:22px;font-weight:600;margin:0 0 8px}p{color:#687182;margin:0 0 18px;word-break:break-word}
a{display:inline-block;height:34px;line-height:34px;padding:0 18px;border-radius:17px;background:#0e7c6b;color:#fff;font-weight:600;text-decoration:none}
</style></head><body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p>${script ? '' : '<a href="">Try again</a>'}</main>${script}</body></html>`;
}

function sendError(req, res, status, heading, detail) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const dest = req.headers['sec-fetch-dest'];
  res.status(status);
  if (dest === 'document' || dest === 'iframe') {
    setDocumentPolicy(req, res);
    res.type('html').send(errorPage(heading, detail));
  } else {
    res.type('text').send(detail);
  }
}

// A request whose token is unknown, expired, or from another IP. Documents
// get a page that tells the browser UI (its parent) to go back to sign-in.
function sendSessionEnded(req, res) {
  setCors(res);
  res.set('Cache-Control', 'no-store');
  const dest = req.headers['sec-fetch-dest'];
  if (dest === 'document' || dest === 'iframe') {
    res.status(401).type('html').send(
      errorPage('Your session has ended', 'Sign in again to keep browsing.', {
        script: '<script>try{parent.postMessage({nb:"expired"},"*")}catch(e){}</script>',
      })
    );
  } else {
    res.status(401).type('text').send('session ended');
  }
}

// --- The /p/ route ---------------------------------------------------------------

async function handleProxyRequest(req, res) {
  const startedAt = Date.now();
  const parsed = fromProxyPath(req.originalUrl);

  setCors(res);
  res.set('Cache-Control', 'no-store'); // nothing proxied is ever written to the browser's disk cache

  if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
    answerPreflight(req, res);
    return;
  }
  if (!parsed) {
    sendError(req, res, 400, 'That address isn’t valid', 'The browser couldn’t work out which site to load.');
    return;
  }
  const s = session.fromToken(parsed.token, req.ip);
  if (!s) {
    sendSessionEnded(req, res);
    return;
  }

  const token = parsed.token;
  const toProxy = (absoluteUrl) => toProxyUrl(absoluteUrl, token);
  let targetUrl;
  try {
    targetUrl = stripTrackingParams(parsed.url);
  } catch (e) {
    targetUrl = parsed.url;
  }

  // Several event paths below (upstream error, response finish, the
  // top-level response error listener) can all fire for the same request,
  // e.g. a client abort surfaces as both a write error and a stream-end
  // event. This keeps each request to exactly one log entry.
  let logged = false;
  const recordOnce = (entry) => {
    if (logged) return;
    logged = true;
    session.log(s, { url: targetUrl, durationMs: Date.now() - startedAt, ...entry });
  };

  // A response stream can fail mid-write for entirely ordinary reasons --
  // most commonly the browser aborting a request because a <video> seek
  // superseded it. An 'error' event with no listener is a thrown exception
  // in Node and takes the whole process down with it, so this listener is
  // not optional.
  res.on('error', (err) => {
    recordOnce({ ok: false, message: `response stream error: ${err.message}` });
  });

  // Proxied pages may only be shown inside the browser UI's sandboxed
  // frames. Opened as a normal top-level page they would share this app's
  // origin, so refuse that outright.
  if (req.headers['sec-fetch-dest'] === 'document') {
    res.status(403);
    res.type('html').send(errorPage('Open this in the browser', 'Pages can only be viewed inside the private browser.', { script: '<p><a href="/app/">Go to the browser</a></p>' }));
    return;
  }

  if (isBlocked(targetUrl)) {
    recordOnce({ status: 204, ok: true, kind: 'blocked', message: 'tracker blocked' });
    res.status(204).end();
    return;
  }

  const controller = new AbortController();
  // Client disconnect = our response closing before it finished. (Not
  // req's 'close': that also fires as soon as a request body has been
  // fully read, which would abort every proxied POST mid-flight.)
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  try {
    let upstream;
    try {
      upstream = await fetchUpstream(req, targetUrl, controller.signal);
    } catch (err) {
      const status = err.statusCode || (err.name === 'AbortError' ? 499 : 502);
      recordOnce({ status, ok: false, message: err.message });
      sendError(req, res, status, 'This site can’t be reached', `${new URL(targetUrl).host}: ${err.message}`);
      return;
    }

    const { res: upstreamRes, finalUrl } = upstream;

    if (isRedirect(upstreamRes.statusCode) && upstreamRes.headers.location) {
      upstreamRes.resume(); // discard body
      let location;
      try {
        location = toProxy(new URL(upstreamRes.headers.location, finalUrl).toString());
      } catch (e) {
        location = null;
      }
      if (location) {
        recordOnce({ status: upstreamRes.statusCode, ok: true, kind: 'redirect', message: `-> ${upstreamRes.headers.location}` });
        res.redirect(upstreamRes.statusCode, location);
        return;
      }
    }

    const kind = contentKind(upstreamRes.headers['content-type'], finalUrl);

    for (const h of PASSTHROUGH_RESPONSE_HEADERS) {
      if (upstreamRes.headers[h]) res.set(h, upstreamRes.headers[h]);
    }

    // Text formats need to be decoded, rewritten, and re-sent uncompressed
    // (content-length below reflects the rewritten body, so drop the old
    // one). A 206 Partial Content response can't be safely rewritten (it's
    // a byte slice, not a parseable document), so fall through to binary
    // passthrough.
    if (kind !== 'binary' && upstreamRes.statusCode !== 206 && req.method !== 'HEAD') {
      let body;
      try {
        body = await decodeBody(upstreamRes);
      } catch (err) {
        recordOnce({ status: 502, ok: false, message: `body read failed: ${err.message}`, kind });
        sendError(req, res, 502, 'This page couldn’t be loaded', `The site sent a response that couldn’t be read (${err.message}).`);
        return;
      }
      let text = body.toString('utf8');

      if (kind === 'html') {
        text = rewriteHtml(text, finalUrl, toProxy, { headInject: metaPolicyTag(req) + SHIM_TAG });
        setDocumentPolicy(req, res);
      } else if (kind === 'css') text = rewriteCss(text, finalUrl, toProxy);
      else if (kind === 'hls') text = rewriteHls(text, finalUrl, toProxy);
      else if (kind === 'dash') text = rewriteDash(text, finalUrl, toProxy);

      res.status(upstreamRes.statusCode);
      res.removeHeader('Content-Encoding');
      res.set('Content-Length', Buffer.byteLength(text));
      res.send(text);
      recordOnce({ status: upstreamRes.statusCode, ok: true, kind });
      return;
    }

    // Binary passthrough (images, fonts, JS, media segments/files): stream
    // straight through, including Range/206 semantics, without buffering.
    res.status(upstreamRes.statusCode);
    if (upstreamRes.headers['content-length']) {
      res.set('Content-Length', upstreamRes.headers['content-length']);
    }
    if (upstreamRes.headers['content-range']) {
      res.set('Content-Range', upstreamRes.headers['content-range']);
    }
    if (upstreamRes.headers['content-encoding']) {
      res.set('Content-Encoding', upstreamRes.headers['content-encoding']);
    }
    // A piped stream can end via 'finish' (all bytes flushed) or 'error'
    // (upstream broke, or -- most commonly -- the client itself disconnected
    // mid-stream, e.g. a <video> seek aborting the request). recordOnce
    // keeps that to a single log entry either way.
    upstreamRes.on('error', (err) => {
      recordOnce({ ok: false, message: `upstream stream error: ${err.message}`, kind });
      res.end();
    });
    res.on('finish', () => {
      recordOnce({ status: upstreamRes.statusCode, ok: true, kind });
    });
    upstreamRes.pipe(res);
  } catch (err) {
    // Last-resort net: anything thrown or rejected above that wasn't
    // already handled (e.g. a rewrite function choking on unusual markup)
    // becomes a clean error response instead of an unhandled rejection
    // that would crash the whole process for every other user.
    recordOnce({ status: 500, ok: false, message: `unexpected error: ${err.message}` });
    sendError(req, res, 500, 'This page couldn’t be loaded', 'Something went wrong while loading it. Try again.');
  }
}

module.exports = { handleProxyRequest, answerPreflight, setCors, contentKind };
