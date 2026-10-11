# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Videos no longer stop partway through, which happened most on mobile. The
  20-second upstream timeout also fired while the player had paused its
  download on a full buffer, which cut the stream off. A stream that breaks
  is now dropped instead of ended, so the player asks for the rest again.
- The sign-in page, and signing out, no longer take seconds in a browser
  with a large cache. `Clear-Site-Data` no longer includes `"cache"`: every
  response is already `no-store`, so it cleared nothing, but Chrome still
  scanned its whole disk cache before showing the page.

### Changed

- A colourful look for the browser UI and sign-in page: each control has
  its own colour, a gradient brand mark, and coloured letter badges for
  sites without a favicon.
- The start page has quick links and a short list of what the browser
  does to keep you private.

## [1.0.0] - 2026-09-26

First public release.

### Added

- Rewriting web proxy with path-style URLs (`/p/<token>/<scheme>/<host>/...`).
- Browser UI with a tab sidebar, per-tab history, address card and "Go to" box.
- Sandboxed pages: every proxied page runs in its own opaque origin.
- Runtime shim for URLs that scripts create after load, plus in-memory cookies,
  storage and locks for pages.
- Server-side tracker blocking and removal of tracking parameters.
- In-memory sessions that end on sign-out, tab close, 30 minutes idle or 12 hours.
- `Clear-Site-Data` on sign-out, tab close and every load of the sign-in page.
- Sign-in rate limiting and constant-time password comparison.
- HTTP range requests, and HLS and DASH manifest rewriting for video.
- Docker image and CI on Node 20, 22 and 24.

[1.0.0]: https://github.com/masghar/relay-browser/releases/tag/v1.0.0
