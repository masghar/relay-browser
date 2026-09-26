'use strict';

// Proxy URL scheme: `/p/<token>/<scheme>/<host[:port]><path>?<query>`.
//
// Path-style (rather than `/proxy?url=<encoded>`) matters for JS-heavy
// sites: the browser resolves relative URLs against the proxied document's
// own path, so scripts that compute URLs at runtime (webpack chunk loading
// from document.currentScript, relative fetch() calls, ...) land back on
// the proxy with the right token, host and directory instead of our root.
//
// The token authorises the request (see session.js): proxied pages run in
// sandboxed, opaque-origin frames and carry no cookies.

const PREFIX = '/p/';
const PROXY_PATH_RE = /^\/p\/([A-Za-z0-9_-]{8,})\/(https?)\/([^/?#]+)(.*)$/i;

function toProxyUrl(absoluteUrl, token) {
  const u = new URL(absoluteUrl);
  return `${PREFIX}${token}/${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}${u.hash}`;
}

/** `/p/<token>/https/host/path?q` -> { token, url }, or null. */
function fromProxyPath(pathAndQuery) {
  if (!pathAndQuery) return null;
  const m = pathAndQuery.match(PROXY_PATH_RE);
  if (!m) return null;
  let rest = m[4];
  if (!rest.startsWith('/')) rest = '/' + rest;
  try {
    return { token: m[1], url: new URL(`${m[2].toLowerCase()}://${m[3]}${rest}`).toString() };
  } catch (e) {
    return null;
  }
}

/**
 * If `referer` is one of our own proxied pages, return { token, url } for
 * the page it's showing. Used to route stray requests (a proxied page's
 * script asking for `/api/foo` on *our* origin) back to the right site.
 */
function targetFromReferer(referer, ourHost) {
  if (!referer) return null;
  let r;
  try {
    r = new URL(referer);
  } catch (e) {
    return null;
  }
  if (r.host !== ourHost) return null;
  return fromProxyPath(r.pathname + r.search);
}

function resolveStray(pathAndQuery, targetPageUrl) {
  return new URL(pathAndQuery, targetPageUrl).toString();
}

// Cross-site tracking identifiers appended to links.
const TRACKING_PARAM_RE = /^(utm_[a-z0-9_]+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|yclid|twclid|ttclid|li_fat_id|igshid|mc_cid|mc_eid|_hsenc|_hsmi|__hssc|__hstc|__hsfp|hsctatracking|oly_anon_id|oly_enc_id|vero_id|wickedid|rb_clickid|s_cid|ef_id)$/i;

function stripTrackingParams(absoluteUrl) {
  const u = new URL(absoluteUrl);
  if (!u.search) return absoluteUrl;
  const keep = [...u.searchParams].filter(([k]) => !TRACKING_PARAM_RE.test(k));
  if (keep.length === [...u.searchParams].length) return absoluteUrl;
  u.search = new URLSearchParams(keep).toString();
  return u.toString();
}

module.exports = { PREFIX, toProxyUrl, fromProxyPath, targetFromReferer, resolveStray, stripTrackingParams };
