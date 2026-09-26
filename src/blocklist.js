'use strict';

// Tracker/ad blocking, applied server-side to every proxied request.
// Blocked requests get an empty 204, which pages treat like a request that
// returned nothing -- far less breakage than an error.
//
// Deliberately a compact list of the large ad/analytics networks rather
// than a full filter list: every entry is a host that exists only to
// track or advertise, so matching on it can't take down real content.

const BLOCKED_HOSTS = [
  // Google ads & analytics
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com', 'doubleclick.net',
  'googlesyndication.com', 'googleadservices.com', 'adservice.google.com', 'pagead2.googlesyndication.com',
  'imasdk.googleapis.com', 'app-measurement.com', 'analytics.google.com', 'stats.g.doubleclick.net',
  // Meta / social trackers
  'connect.facebook.net', 'pixel.facebook.com', 'an.facebook.com', 'analytics.tiktok.com',
  'ads.tiktok.com', 'analytics.twitter.com', 'ads-twitter.com', 'static.ads-twitter.com',
  'px.ads.linkedin.com', 'snap.licdn.com', 'ct.pinterest.com', 'sc-static.net', 'tr.snapchat.com',
  // Microsoft / Yandex / others
  'bat.bing.com', 'clarity.ms', 'mc.yandex.ru', 'mc.yandex.com', 'mc.webvisor.org', 'mdd.yandex.net', 'hdrc.yandex.net',
  // Product analytics / session replay
  'hotjar.com', 'hotjar.io', 'mixpanel.com', 'segment.io', 'segment.com', 'amplitude.com', 'heap.io',
  'heapanalytics.com', 'fullstory.com', 'mouseflow.com', 'crazyegg.com', 'luckyorange.com',
  'logrocket.io', 'lr-ingest.io', 'smartlook.com', 'inspectlet.com', 'quantummetric.com',
  'contentsquare.net', 'clicktale.net', 'kissmetrics.com', 'chartbeat.com', 'chartbeat.net',
  'parsely.com', 'parse.ly', 'newrelic.com', 'nr-data.net', 'optimizely.com', 'mxpnl.com',
  // Measurement / ad tech
  'scorecardresearch.com', 'quantserve.com', 'quantcount.com', 'comscore.com', 'adnxs.com',
  'adsrvr.org', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'pubmatic.com',
  'rubiconproject.com', 'openx.net', 'casalemedia.com', 'amazon-adsystem.com', 'moatads.com',
  'doubleverify.com', 'adsafeprotected.com', 'serving-sys.com', 'smartadserver.com', 'teads.tv',
  'yieldmo.com', 'sharethrough.com', 'media.net', 'bidswitch.net', 'demdex.net', 'omtrdc.net',
  'everesttech.net', 'krxd.net', 'bluekai.com', 'exelator.com', 'rlcdn.com', 'agkn.com',
  'adform.net', 'mathtag.com', 'tapad.com', 'turn.com', 'zemanta.com', 'yieldlove.com',
  'onetrust.io', 'trustarc.com', 'cookielaw.org', 'tinypass.com', 'piano.io', 'cxense.com',
  'exoclick.com', 'trafficjunky.net', 'juicyads.com', 'popads.net', 'propellerads.com',
  'adsterra.com', 'hilltopads.net', 'trafficstars.com', 'tsyndicate.com', 'bngpt.com',
];

// First-party tracking endpoints on sites that are otherwise needed.
const BLOCKED_PATHS = [
  /^\/(gtag|gtm)\.js/i,
  /^\/(g|j)\/collect\b/i,
  /^\/collect\b/i,
  /^\/gtg\/ga\//i,
  /^\/youtubei\/v1\/log_event\b/i,
  /^\/api\/stats\/(qoe|atr|ads|watchtime)\b/i,
  /^\/ptracking\b/i,
  /^\/generate_204\b/i,
  /^\/pagead\//i,
  /^\/tr\/?$/i, // Meta pixel on first-party domains
];

const hostSet = new Set(BLOCKED_HOSTS);

function isBlocked(absoluteUrl) {
  let u;
  try {
    u = new URL(absoluteUrl);
  } catch (e) {
    return false;
  }
  const host = u.hostname.toLowerCase();
  // Exact host or any parent domain on the list.
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (hostSet.has(parts.slice(i).join('.'))) return true;
  }
  return BLOCKED_PATHS.some((re) => re.test(u.pathname));
}

module.exports = { isBlocked };
