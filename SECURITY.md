# Security policy

relay-browser is built to protect its users' privacy, so security reports are taken
seriously.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately
through GitHub: go to the **Security** tab of the repository and choose **Report a
vulnerability**.

Include what you found, how to reproduce it, and what an attacker could do with it.
You should get a reply within a few days. Once a fix is released you'll be credited,
unless you'd rather not be.

## What counts

Examples of issues in scope:

- a proxied page reading the browser UI, another tab, or the session token
- a request from a proxied page reaching a third party directly, or leaking the
  user's IP address
- data that outlives sign-out or closing the tab (cookies, storage, cache, logs)
- bypassing the password gate or the sign-in rate limit
- server-side request forgery beyond what the proxy is designed to do for a
  signed-in user

Out of scope: problems that need an already signed-in user to attack themselves, and
sites that simply don't render (please open a normal issue for those).

## Supported versions

Only the latest release on the `main` branch gets security fixes.
