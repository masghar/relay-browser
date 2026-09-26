# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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
