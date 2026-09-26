'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  rewriteHtml,
  rewriteCss,
  rewriteHls,
  rewriteDash,
  rewriteSrcset,
  proxify,
} = require('../src/rewrite');

const BASE = 'https://example.com/dir/page.html';
const toProxy = (absoluteUrl) => `/proxy?url=${encodeURIComponent(absoluteUrl)}`;

test('proxify resolves relative URLs against the base and wraps them', () => {
  assert.equal(
    proxify(BASE, '/style.css', toProxy),
    '/proxy?url=' + encodeURIComponent('https://example.com/style.css')
  );
  assert.equal(
    proxify(BASE, 'img.png', toProxy),
    '/proxy?url=' + encodeURIComponent('https://example.com/dir/img.png')
  );
});

test('proxify leaves data:, mailto:, javascript: and anchors alone', () => {
  for (const url of ['data:image/png;base64,AAA', 'mailto:a@b.com', 'javascript:void(0)', '#section']) {
    assert.equal(proxify(BASE, url, toProxy), url);
  }
});

test('rewriteHtml rewrites href/src/action across common tags', () => {
  const html = `<html><body>
    <a href="/about">About</a>
    <img src="pic.jpg">
    <link rel="stylesheet" href="/css/main.css">
    <script src="/js/app.js"></script>
    <video src="/v.mp4" poster="/poster.jpg"></video>
    <audio src="/a.mp3"></audio>
    <iframe src="https://embed.example.com/x"></iframe>
    <form action="/submit"></form>
  </body></html>`;
  const out = rewriteHtml(html, BASE, toProxy);
  assert.match(out, /href="\/proxy\?url=.*about/);
  assert.match(out, /src="\/proxy\?url=.*pic\.jpg/);
  assert.match(out, /href="\/proxy\?url=.*main\.css/);
  assert.match(out, /src="\/proxy\?url=.*app\.js/);
  assert.match(out, /src="\/proxy\?url=.*v\.mp4/);
  assert.match(out, /poster="\/proxy\?url=.*poster\.jpg/);
  assert.match(out, /src="\/proxy\?url=.*a\.mp3/);
  assert.match(out, /src="\/proxy\?url=.*embed\.example\.com/);
  assert.match(out, /action="\/proxy\?url=.*submit/);
});

test('rewriteHtml strips CSP/X-Frame-Options meta tags', () => {
  const html = `<html><head>
    <meta http-equiv="Content-Security-Policy" content="frame-ancestors 'none'">
    <meta http-equiv="X-Frame-Options" content="DENY">
  </head><body>ok</body></html>`;
  const out = rewriteHtml(html, BASE, toProxy);
  assert.doesNotMatch(out, /Content-Security-Policy/i);
  assert.doesNotMatch(out, /X-Frame-Options/i);
});

test('rewriteHtml rewrites inline <style> and style="" url()', () => {
  const html = `<html><head><style>body{background:url('/bg.png')}</style></head>
  <body><div style="background-image:url(/hero.jpg)"></div></body></html>`;
  const out = rewriteHtml(html, BASE, toProxy);
  assert.match(out, /url\('\/proxy\?url=.*bg\.png/);
  assert.match(out, /url\(\/proxy\?url=.*hero\.jpg/);
});

test('rewriteSrcset rewrites each candidate url and keeps descriptors', () => {
  const out = rewriteSrcset(BASE, '/a.jpg 1x, /b.jpg 2x', toProxy);
  const parts = out.split(', ');
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^\/proxy\?url=.*a\.jpg 1x$/);
  assert.match(parts[1], /^\/proxy\?url=.*b\.jpg 2x$/);
});

test('rewriteCss rewrites url() and @import, skips data URIs', () => {
  const css = `
    @import "/base.css";
    .a { background: url(/img/a.png); }
    .b { background: url("data:image/png;base64,AAAA"); }
  `;
  const out = rewriteCss(css, BASE, toProxy);
  assert.match(out, /@import "\/proxy\?url=.*base\.css"/);
  assert.match(out, /url\(\/proxy\?url=.*a\.png\)/);
  assert.match(out, /data:image\/png;base64,AAAA/);
});

test('rewriteHls rewrites segment/playlist URIs and URI="" attributes', () => {
  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="/key.bin"',
    '#EXTINF:6.0,',
    'seg0.ts',
    '#EXTINF:6.0,',
    '/segs/seg1.ts',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000',
    'variant.m3u8',
  ].join('\n');
  const out = rewriteHls(m3u8, 'https://cdn.example.com/hls/index.m3u8', toProxy);
  const lines = out.split('\n');
  assert.match(lines[1], /URI="\/proxy\?url=.*key\.bin"/);
  assert.match(lines[3], /^\/proxy\?url=.*seg0\.ts/);
  assert.match(lines[5], /^\/proxy\?url=.*segs%2Fseg1\.ts|segs\/seg1\.ts/);
  assert.match(lines[7], /^\/proxy\?url=.*variant\.m3u8/);
  assert.ok(lines[0] === '#EXTM3U');
});

test('rewriteDash rewrites BaseURL and SegmentTemplate attributes, preserves $Number$ tokens', () => {
  const mpd = `<MPD><Period>
    <BaseURL>/dash/</BaseURL>
    <AdaptationSet>
      <SegmentTemplate initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number$.m4s"/>
    </AdaptationSet>
  </Period></MPD>`;
  const out = rewriteDash(mpd, 'https://cdn.example.com/dash/index.mpd', toProxy);
  assert.match(out, /<BaseURL>\/proxy\?url=.*<\/BaseURL>/);
  assert.match(out, /initialization="\/proxy\?url=[^"]*\$RepresentationID\$/);
  assert.match(out, /media="\/proxy\?url=[^"]*\$RepresentationID\$.*\$Number\$/);
});

test('rewriteHtml rewrites <base href>, drops referrer meta, and injects into <head> first', () => {
  const html = '<html><head><meta name="referrer" content="no-referrer"><base href="/root/"><script src="a.js"></script></head><body></body></html>';
  const out = rewriteHtml(html, BASE, toProxy, { headInject: '<script id="shim"></script>' });
  assert.ok(!/name="referrer"/i.test(out));
  assert.ok(out.includes('href="' + toProxy('https://example.com/root/') + '"'));
  assert.ok(/<head><script id="shim"><\/script>/.test(out), out);
});

test('rewriteHtml adds an import map covering every referenced origin, merging an existing one', () => {
  const html = '<html><head><script type="importmap">{"imports":{"lib":"https://cdn.test/lib.js"}}</script>' +
    '<script type="module" src="https://assets.test/app.js"></script></head><body><img src="/a.png"></body></html>';
  const out = rewriteHtml(html, BASE, toProxy, { headInject: '<script id="shim"></script>' });
  const maps = out.match(/<script type="importmap">([\s\S]*?)<\/script>/g);
  assert.equal(maps.length, 1);
  const map = JSON.parse(maps[0].replace(/^<script type="importmap">|<\/script>$/g, ''));
  assert.equal(map.imports.lib, toProxy('https://cdn.test/lib.js'));
  assert.equal(map.imports['https://assets.test/'], toProxy('https://assets.test/'));
  assert.equal(map.imports['https://example.com/'], toProxy('https://example.com/'));
  assert.ok(/<head><script id="shim"><\/script><script type="importmap">/.test(out), 'shim first, then the import map');
  assert.ok(!/data-nb-orig/.test(out), 'bookkeeping attributes are removed');
});
