# Contributing

Thanks for taking the time to help. Bug reports, fixes, site-compatibility patches
and documentation improvements are all welcome.

## Setting up

```sh
git clone https://github.com/masghar/relay-browser.git
cd relay-browser
npm install
cp .env.example .env    # set APP_PASSWORD
npm start               # http://localhost:3000
npm test
```

Node.js 20 or newer is required. There is no build step: edit a file and restart.

## Reporting a site that doesn't work

Most bugs are "site X doesn't load properly". When you open an issue, please include:

- the exact URL
- what you expected and what you saw (a screenshot helps)
- errors from your browser's developer console, if any
- the request log (sidebar, **Log**) entries that failed

Please don't include anything personal from the pages you were browsing.

## Making changes

- Keep pull requests focused on one change. Small PRs get reviewed faster.
- Add or update tests in `test/` for anything in `src/rewrite.js` or
  `src/proxyUrl.js`. Those are pure functions and easy to test.
- For changes to the runtime shim (`src/clientShim.js`) or the proxy, describe which
  sites you tested with and how.
- Match the existing style: 2-space indent, single quotes, semicolons, and comments
  that explain *why* rather than *what*.
- Run `npm test` before pushing. CI runs it on Node 20, 22 and 24.

## Privacy and security are features

relay-browser makes promises to its users (see the README). Changes must keep them:

- no request from a proxied page may reach a third party directly
- nothing may be persisted in the user's browser or on the server's disk
- proxied pages must stay sandboxed from the browser UI and from each other

If a change weakens any of these, even to fix a site, say so in the PR so it can be
discussed.

## Commit messages

Write them in the imperative ("Fix HLS key URI rewriting", not "Fixed ..."). Keep the
first line under about 70 characters, and use the body to explain why.

## Code of conduct

By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).
