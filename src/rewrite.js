'use strict';

const cheerio = require('cheerio');

/**
 * Rewriting engine for the network-browser proxy.
 *
 * Every function here takes the *original* absolute URL a piece of content
 * was fetched from (`baseUrl`) and a `toProxy(absoluteUrl)` callback that
 * turns an absolute URL into a same-origin proxy URL (e.g. `/proxy?url=...`).
 * Keeping the proxy-URL scheme out of this module is what makes it testable
 * without spinning up the server.
 */

const REWRITE_ATTRS = [
  { selector: 'base[href]', attr: 'href' },
  { selector: 'a[href]', attr: 'href' },
  { selector: 'link[href]', attr: 'href' },
  { selector: 'img[src]', attr: 'src' },
  { selector: 'script[src]', attr: 'src' },
  { selector: 'source[src]', attr: 'src' },
  { selector: 'video[src]', attr: 'src' },
  { selector: 'video[poster]', attr: 'poster' },
  { selector: 'audio[src]', attr: 'src' },
  { selector: 'track[src]', attr: 'src' },
  { selector: 'iframe[src]', attr: 'src' },
  { selector: 'embed[src]', attr: 'src' },
  { selector: 'form[action]', attr: 'action' },
];

const SRCSET_SELECTORS = ['img[srcset]', 'source[srcset]'];

function isRewritable(url) {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (/^(data|blob|mailto|tel|javascript|about):/i.test(trimmed)) return false;
  if (trimmed.startsWith('#')) return false;
  return true;
}

function resolveUrl(baseUrl, maybeRelative) {
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch (e) {
    return null;
  }
}

function proxify(baseUrl, rawUrl, toProxy) {
  if (!isRewritable(rawUrl)) return rawUrl;
  const absolute = resolveUrl(baseUrl, rawUrl);
  if (!absolute) return rawUrl;
  return toProxy(absolute);
}

function rewriteSrcset(baseUrl, srcset, toProxy) {
  return srcset
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;
      const spaceIdx = trimmed.search(/\s/);
      const url = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const descriptor = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);
      return proxify(baseUrl, url, toProxy) + descriptor;
    })
    .join(', ');
}

const CSS_URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(['"])(.*?)\1/gi;

function rewriteCss(css, baseUrl, toProxy) {
  if (!css) return css;
  let out = css.replace(CSS_URL_RE, (match, quote, url) => {
    if (!isRewritable(url)) return match;
    return `url(${quote}${proxify(baseUrl, url, toProxy)}${quote})`;
  });
  out = out.replace(CSS_IMPORT_RE, (match, quote, url) => {
    if (!isRewritable(url)) return match;
    return `@import ${quote}${proxify(baseUrl, url, toProxy)}${quote}`;
  });
  return out;
}

function rewriteHtml(html, baseUrl, toProxy, { headInject } = {}) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // Drop CSP meta tags -- they'd otherwise block proxied sub-resources
  // client-side even after we strip the CSP response header.
  $('meta[http-equiv="Content-Security-Policy" i]').remove();
  $('meta[http-equiv="X-Frame-Options" i]').remove();
  // The server routes stray same-origin requests back to the right site by
  // reading the Referer, so a page must not be allowed to suppress it.
  $('meta[name="referrer" i]').remove();

  // Meta refresh redirects: content="5;url=https://...".
  $('meta[http-equiv="refresh" i]').each((_, el) => {
    const content = $(el).attr('content');
    if (!content) return;
    const m = content.match(/^(\d+)\s*;\s*url=(.+)$/i);
    if (!m) return;
    const proxied = proxify(baseUrl, m[2].trim().replace(/^['"]|['"]$/g, ''), toProxy);
    $(el).attr('content', `${m[1]};url=${proxied}`);
  });

  for (const { selector, attr } of REWRITE_ATTRS) {
    $(selector).each((_, el) => {
      const val = $(el).attr(attr);
      if (!val) return;
      if (isRewritable(val)) {
        const abs = resolveUrl(baseUrl, val);
        if (abs && /^https?:/i.test(abs)) $(el).attr('data-nb-orig-' + attr, new URL(abs).origin);
      }
      $(el).attr(attr, proxify(baseUrl, val, toProxy));
    });
  }

  for (const selector of SRCSET_SELECTORS) {
    $(selector).each((_, el) => {
      const val = $(el).attr('srcset');
      if (!val) return;
      $(el).attr('srcset', rewriteSrcset(baseUrl, val, toProxy));
    });
  }

  $('style').each((_, el) => {
    const css = $(el).html();
    if (css) $(el).html(rewriteCss(css, baseUrl, toProxy));
  });

  $('[style]').each((_, el) => {
    const style = $(el).attr('style');
    if (style && style.includes('url(')) {
      $(el).attr('style', rewriteCss(style, baseUrl, toProxy));
    }
  });

  // ES module imports with absolute URLs (`import "https://cdn/x.js"`,
  // including dynamic import()) can't be intercepted from JS; an import
  // map can remap them. Map every origin the page references onto the
  // proxy, and fold in (and proxify) any import map the page already has.
  const importMap = buildImportMap($, baseUrl, toProxy);

  // Both must run before any of the page's own scripts, so they go first in
  // <head>, shim then import map (cheerio always gives us a <head>).
  if (importMap) $('head').prepend(importMap);
  if (headInject) $('head').prepend(headInject);

  return $.html();
}

function buildImportMap($, baseUrl, toProxy) {
  const origins = new Set();
  try {
    origins.add(new URL(baseUrl).origin);
  } catch (e) {}
  for (const { selector, attr } of REWRITE_ATTRS) {
    $(selector).each((_, el) => {
      const original = $(el).attr('data-nb-orig-' + attr);
      if (original) origins.add(original);
    });
  }

  const merged = { imports: {}, scopes: {} };
  const proxifyMapValues = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      out[k] = typeof v === 'string' ? proxify(baseUrl, v, toProxy) : v;
    }
    return out;
  };
  $('script[type="importmap" i]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).html() || '{}');
      Object.assign(merged.imports, proxifyMapValues(parsed.imports));
      for (const [scope, entries] of Object.entries(parsed.scopes || {})) {
        merged.scopes[proxify(baseUrl, scope, toProxy)] = proxifyMapValues(entries);
      }
      $(el).remove();
    } catch (e) {
      // Unparseable: leave it; the browser will ignore it the same way.
    }
  });

  for (const origin of origins) {
    const key = origin + '/';
    if (!(key in merged.imports)) merged.imports[key] = toProxy(key);
  }
  $('[data-nb-orig-src], [data-nb-orig-href], [data-nb-orig-action], [data-nb-orig-poster]').each((_, el) => {
    for (const a of ['src', 'href', 'action', 'poster']) $(el).removeAttr('data-nb-orig-' + a);
  });
  if (!Object.keys(merged.scopes).length) delete merged.scopes;
  const json = JSON.stringify(merged).replace(/</g, '\\u003c');
  return `<script type="importmap">${json}</script>`;
}

// --- HLS (.m3u8) -----------------------------------------------------------

function rewriteHls(text, baseUrl, toProxy) {
  const lines = text.split(/\r?\n/);
  const out = lines.map((line) => {
    if (!line.trim()) return line;

    if (line.startsWith('#')) {
      // Tags that carry a URI="..." attribute (encryption keys, init maps).
      return line.replace(/URI="([^"]+)"/i, (match, uri) => {
        return `URI="${proxify(baseUrl, uri, toProxy)}"`;
      });
    }

    // A bare line that isn't a comment is a URI: either a media segment
    // or a nested (variant) playlist.
    return proxify(baseUrl, line.trim(), toProxy);
  });
  return out.join('\n');
}

// --- DASH (.mpd) -------------------------------------------------------------
// Regex-based, not a full XML parser: covers BaseURL elements and the
// initialization/media/sourceURL attributes used by SegmentTemplate /
// SegmentURL, which is what real-world manifests use in practice. Template
// tokens like $Number$/$Time$ pass through untouched since players
// string-substitute them into the (already proxied) URL before fetching.

const DASH_BASEURL_RE = /(<BaseURL[^>]*>)([\s\S]*?)(<\/BaseURL>)/gi;
const DASH_ATTR_RE = /\b(initialization|media|sourceURL)="([^"]*)"/gi;

// DASH template tokens ($Number$, $Time$, $RepresentationID$, ...) must stay
// literal in the proxied URL: players do a string-substitute on the URL
// template *before* fetching, matching the literal `$...$` form. proxify()
// runs the target through encodeURIComponent, which escapes `$` to `%24`
// and would hide the tokens from that substitution -- so for template-
// bearing attributes we restore literal `$` after encoding. `$` is a legal
// unencoded query-string character, so this doesn't produce a broken URL.
function proxifyTemplate(baseUrl, rawUrl, toProxy) {
  return proxify(baseUrl, rawUrl, toProxy).replace(/%24/g, '$');
}

function rewriteDash(xml, baseUrl, toProxy) {
  let out = xml.replace(DASH_BASEURL_RE, (match, open, url, close) => {
    if (!isRewritable(url.trim())) return match;
    return `${open}${proxifyTemplate(baseUrl, url.trim(), toProxy)}${close}`;
  });
  out = out.replace(DASH_ATTR_RE, (match, name, url) => {
    if (!isRewritable(url)) return match;
    return `${name}="${proxifyTemplate(baseUrl, url, toProxy)}"`;
  });
  return out;
}

module.exports = {
  isRewritable,
  resolveUrl,
  proxify,
  rewriteHtml,
  rewriteCss,
  rewriteSrcset,
  rewriteHls,
  rewriteDash,
};
