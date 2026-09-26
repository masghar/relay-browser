'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toProxyUrl, fromProxyPath, targetFromReferer, resolveStray, stripTrackingParams } = require('../src/proxyUrl');

const TOK = 'abcDEF_123-xyz';

test('toProxyUrl puts token, scheme and host in path segments, keeping path/query/hash', () => {
  assert.equal(toProxyUrl('https://www.youtube.com/watch?v=abc#t=1', TOK), `/p/${TOK}/https/www.youtube.com/watch?v=abc#t=1`);
  assert.equal(toProxyUrl('http://localhost:8080/', TOK), `/p/${TOK}/http/localhost:8080/`);
});

test('fromProxyPath round-trips toProxyUrl', () => {
  for (const u of ['https://www.youtube.com/watch?v=abc', 'http://localhost:8080/a//b?x=1&y=%20', 'https://cdn.example.com/$Number$.m4s']) {
    assert.deepEqual(fromProxyPath(toProxyUrl(u, TOK)), { token: TOK, url: u });
  }
});

test('fromProxyPath rejects non-proxy paths, missing tokens and non-http schemes', () => {
  assert.equal(fromProxyPath('/app/'), null);
  assert.equal(fromProxyPath(`/p/${TOK}/ftp/x.com/`), null);
  assert.equal(fromProxyPath('/p/https/x.com/'), null);
  assert.equal(fromProxyPath(`/p/${TOK}/https`), null);
});

test('targetFromReferer finds the proxied page (and token) behind a same-host Referer', () => {
  assert.deepEqual(
    targetFromReferer(`https://me.test/p/${TOK}/https/www.youtube.com/watch?v=1`, 'me.test'),
    { token: TOK, url: 'https://www.youtube.com/watch?v=1' }
  );
  assert.equal(targetFromReferer('https://me.test/app/', 'me.test'), null);
  assert.equal(targetFromReferer(`https://other.test/p/${TOK}/https/a.com/`, 'me.test'), null);
  assert.equal(targetFromReferer(undefined, 'me.test'), null);
});

test('resolveStray maps a root-relative request back onto the referring site', () => {
  assert.equal(resolveStray('/youtubei/v1/guide?prettyPrint=false', 'https://www.youtube.com/'), 'https://www.youtube.com/youtubei/v1/guide?prettyPrint=false');
});

test('stripTrackingParams removes utm_*, click ids and keeps everything else', () => {
  assert.equal(
    stripTrackingParams('https://a.com/x?utm_source=n&id=5&fbclid=abc&gclid=1&UTM_Medium=m#top'),
    'https://a.com/x?id=5#top'
  );
  assert.equal(stripTrackingParams('https://a.com/x?utm_source=n'), 'https://a.com/x');
  assert.equal(stripTrackingParams('https://a.com/x?q=1'), 'https://a.com/x?q=1');
});
