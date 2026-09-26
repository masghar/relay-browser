'use strict';

// Runtime shim injected as the first script of every proxied HTML page.
//
// Proxied pages run sandboxed with an opaque origin (see proxy.js), so they
// can't touch the browser UI, other tabs, or any real browser storage. This
// shim makes that environment work for real sites:
//
//  1. URL routing. Static rewriting (rewrite.js) only reaches URLs present
//     in the markup; modern sites build most of theirs in JS after load.
//     The shim routes those through the proxy at the few choke points JS
//     uses to make requests. What it can't reach (dynamic import(), CSS
//     url() in injected styles, plain navigations) is caught server-side
//     by the stray-request fallback in server.js.
//
//  2. Private storage. document.cookie, localStorage and sessionStorage
//     become in-memory stores that die with the page: nothing a site
//     stores ever reaches the real browser.
//
//  3. Talking to the browser UI -- only by postMessage, and only the
//     page's address and title (for the tab strip) and "open this in a new
//     tab". The UI can't see anything else the page does, including what's
//     typed or clicked in it.

function shimSource() {
  /* eslint-disable */
  return function () {
    // Backstop for the server's top-level guard: a proxied page must only
    // ever run inside a browser tab frame. Stopping here also halts the
    // parser, so none of the page's own scripts run.
    if (window === window.top) {
      window.stop();
      document.documentElement.innerHTML = '<body style="font:15px system-ui;padding:2em">This page can only be viewed inside the private browser. <a href="/app/">Go to the browser</a></body>';
      return;
    }

    // location.origin is "null" in an opaque-origin sandbox; the server
    // this page actually came from is what matters for routing.
    var HOST_ORIGIN = location.protocol + '//' + location.host;
    var m0 = location.pathname.match(/^\/p\/([A-Za-z0-9_-]+)\//);
    var TOKEN = m0 ? m0[1] : '';
    var P = '/p/' + TOKEN + '/';
    var topDoc = document;
    var UI = window.top;
    var isTabRoot = window.parent === window.top && window !== window.top;

    // The site this document is showing, derived from our own path so it
    // stays right after the page pushState()s somewhere else.
    function currentTarget() {
      var m = location.pathname.match(/^\/p\/[A-Za-z0-9_-]+\/(https?)\/([^/]+)(.*)$/);
      if (!m) return null;
      return m[1] + '://' + m[2] + (m[3] || '/') + location.search + location.hash;
    }

    function prox(u) {
      if (u == null || u === '') return u;
      var s = String(u);
      if (/^(data|blob|javascript|about|mailto|tel):/i.test(s) || s.charAt(0) === '#') return u;
      try {
        var abs = new URL(s, topDoc.baseURI);
        if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return u;
        if (abs.protocol + '//' + abs.host === HOST_ORIGIN) {
          if (abs.pathname.indexOf(P) === 0) return u;
          var t = currentTarget();
          if (!t) return u;
          abs = new URL(abs.pathname + abs.search + abs.hash, t);
        }
        return P + abs.protocol.slice(0, -1) + '/' + abs.host + abs.pathname + abs.search + abs.hash;
      } catch (e) {
        return u;
      }
    }

    function toUI(msg) {
      try { UI.postMessage(msg, '*'); } catch (e) {}
    }

    function openAsTab(proxied) {
      if (window === window.top) return false;
      try {
        var abs = new URL(proxied, HOST_ORIGIN);
        toUI({ nb: 'open', path: abs.pathname + abs.search + abs.hash });
        return true;
      } catch (e) {
        return false;
      }
    }

    // --- In-memory storage ----------------------------------------------------

    function makeStorage() {
      var data = Object.create(null);
      var api = {
        getItem: function (k) { k = String(k); return k in data ? data[k] : null; },
        setItem: function (k, v) { data[String(k)] = String(v); },
        removeItem: function (k) { delete data[String(k)]; },
        clear: function () { data = Object.create(null); },
        key: function (i) { var ks = Object.keys(data); return i < ks.length ? ks[i] : null; },
      };
      Object.defineProperty(api, 'length', { configurable: true, get: function () { return Object.keys(data).length; } });
      // Support storage.foo = 'bar' / storage.foo too, like the real thing.
      return new Proxy(api, {
        get: function (t, k) { return k in t ? t[k] : (typeof k === 'string' && k in data ? data[k] : undefined); },
        set: function (t, k, v) { if (k in t) return false; data[String(k)] = String(v); return true; },
        deleteProperty: function (t, k) { delete data[String(k)]; return true; },
        has: function (t, k) { return k in t || k in data; },
        ownKeys: function () { return Object.keys(data); },
        getOwnPropertyDescriptor: function (t, k) {
          if (k in data) return { value: data[k], writable: true, enumerable: true, configurable: true };
          return undefined;
        },
      });
    }

    var cookieJar = Object.create(null);
    function readCookies() {
      var out = [];
      for (var k in cookieJar) out.push(k ? k + '=' + cookieJar[k] : cookieJar[k]);
      return out.join('; ');
    }
    function writeCookie(str) {
      var parts = String(str).split(';');
      var first = parts.shift();
      var eq = first.indexOf('=');
      var name = (eq === -1 ? '' : first.slice(0, eq)).trim();
      var value = (eq === -1 ? first : first.slice(eq + 1)).trim();
      var expired = false;
      parts.forEach(function (p) {
        var a = p.split('=');
        var key = a[0].trim().toLowerCase();
        var val = (a[1] || '').trim();
        if (key === 'max-age' && Number(val) <= 0) expired = true;
        if (key === 'expires' && Date.parse(val) < Date.now()) expired = true;
      });
      if (expired) delete cookieJar[name];
      else cookieJar[name] = value;
    }

    // --- Per-window install ----------------------------------------------------
    // Installed into this window and into any same-origin child frame the
    // page touches: Google's apps (YouTube in particular) grab pristine
    // copies of fetch/History from a blank <iframe> precisely to get
    // around patches like these, then call them on the main window.

    var standIns = new WeakMap();
    function blankFrameStandIn(win) {
      if (standIns.has(win)) return standIns.get(win);
      var fakeDoc = win.document.implementation.createHTMLDocument('');
      var standIn = new Proxy(win, {
        get: function (t, k) {
          if (k === 'document') return fakeDoc;
          if (k === 'window' || k === 'self' || k === 'frames' || k === 'globalThis') return standIn;
          var v = t[k];
          // Methods need the real window as `this`; constructors must stay
          // unbound so `new` still works.
          if (typeof v === 'function' && typeof k === 'string' && !/^[A-Z]/.test(k)) return v.bind(t);
          return v;
        },
        set: function () { return true; },
      });
      standIns.set(win, standIn);
      return standIn;
    }

    var localStore = makeStorage();
    var sessionStore = makeStorage();

    function install(win) {
      if (win.__nbShim) return;
      win.__nbShim = true;

      try {
        Object.defineProperty(win, 'localStorage', { configurable: true, get: function () { return localStore; } });
        Object.defineProperty(win, 'sessionStorage', { configurable: true, get: function () { return sessionStore; } });
      } catch (e) {}
      try {
        Object.defineProperty(win.Document.prototype, 'cookie', {
          configurable: true,
          get: function () { return readCookies(); },
          set: function (v) { writeCookie(v); },
        });
      } catch (e) {}
      // Cache Storage and IndexedDB are unavailable in an opaque-origin
      // sandbox, and fail in ways sites don't expect (reading `caches`
      // throws; indexedDB.open() throws synchronously). Make them fail the
      // normal, asynchronous way so apps fall back instead of crashing.
      try {
        win.caches;
      } catch (e) {
        var denied = function () { return Promise.reject(new win.DOMException('Storage is disabled in this browser', 'SecurityError')); };
        var cachesStub = {
          open: denied,
          has: function () { return Promise.resolve(false); },
          keys: function () { return Promise.resolve([]); },
          match: function () { return Promise.resolve(undefined); },
          delete: function () { return Promise.resolve(false); },
        };
        try { Object.defineProperty(win, 'caches', { configurable: true, get: function () { return cachesStub; } }); } catch (e2) {}
      }
      if (win.IDBFactory) {
        var failedRequest = function (err) {
          var req = new win.EventTarget();
          req.readyState = 'pending';
          req.result = undefined;
          req.error = null;
          req.source = null;
          req.transaction = null;
          req.onsuccess = req.onerror = req.onupgradeneeded = req.onblocked = null;
          req.addEventListener('error', function (ev) { if (typeof req.onerror === 'function') req.onerror.call(req, ev); });
          setTimeout(function () {
            req.readyState = 'done';
            req.error = err;
            req.dispatchEvent(new win.Event('error', { cancelable: true }));
          }, 0);
          return req;
        };
        ['open', 'deleteDatabase'].forEach(function (name) {
          var orig = win.IDBFactory.prototype[name];
          if (!orig) return;
          win.IDBFactory.prototype[name] = function () {
            try {
              return orig.apply(this, arguments);
            } catch (err) {
              return failedRequest(err);
            }
          };
        });
        win.IDBFactory.prototype.databases = function () { return Promise.resolve([]); };
      }
      // Web Locks: also denied in the sandbox. Within one page an
      // in-memory queue per lock name gives the same ordering guarantee.
      if (win.LockManager) {
        var lockChains = Object.create(null);
        win.LockManager.prototype.request = function (name, opts, cb) {
          if (typeof opts === 'function') { cb = opts; opts = {}; }
          var key = String(name);
          var lock = { name: key, mode: (opts && opts.mode) || 'exclusive' };
          var run = (lockChains[key] || Promise.resolve()).then(function () { return cb(lock); });
          lockChains[key] = run.catch(function () {});
          return run;
        };
        win.LockManager.prototype.query = function () { return Promise.resolve({ held: [], pending: [] }); };
      }
      if (win.ServiceWorkerContainer) {
        win.ServiceWorkerContainer.prototype.register = function () {
          return Promise.reject(new Error('service workers are disabled in this browser'));
        };
      }

      // fetch()
      if (win.fetch) {
        var origFetch = win.fetch;
        win.fetch = function (input, init) {
          try {
            if (typeof input === 'string' || input instanceof win.URL || input instanceof URL) {
              input = prox(input);
            } else if (input && input.url) {
              var nu = prox(input.url);
              if (nu !== input.url) input = new win.Request(nu, input);
            }
          } catch (e) {}
          return origFetch.call(this, input, init);
        };
      }

      // XMLHttpRequest
      var origOpen = win.XMLHttpRequest.prototype.open;
      win.XMLHttpRequest.prototype.open = function (method, url) {
        var args = Array.prototype.slice.call(arguments);
        args[1] = prox(url);
        return origOpen.apply(this, args);
      };

      // navigator.sendBeacon
      if (win.Navigator && win.Navigator.prototype.sendBeacon) {
        var origBeacon = win.Navigator.prototype.sendBeacon;
        win.Navigator.prototype.sendBeacon = function (url, data) {
          return origBeacon.call(this, prox(url), data);
        };
      }

      // EventSource / Worker
      ['EventSource', 'Worker', 'SharedWorker'].forEach(function (name) {
        var Orig = win[name];
        if (!Orig) return;
        var Wrapped = function (url, opts) {
          return new Orig(prox(url), opts);
        };
        Wrapped.prototype = Orig.prototype;
        win[name] = Wrapped;
      });

      // window.open -> a new tab in the browser UI.
      var origWinOpen = win.open;
      win.open = function (url) {
        var args = Array.prototype.slice.call(arguments);
        if (url) {
          args[0] = prox(url);
          if (openAsTab(args[0])) return null;
        }
        return origWinOpen.apply(this, args);
      };

      // history: keep the document on a proxy URL when an SPA "navigates".
      // Opaque-origin documents may refuse URL changes; the app then keeps
      // running with its state change and just an unchanged URL.
      ['pushState', 'replaceState'].forEach(function (name) {
        var orig = win.History.prototype[name];
        win.History.prototype[name] = function (state, title, url) {
          if (url == null) return orig.call(this, state, title);
          try {
            var r = orig.call(this, state, title, prox(url));
            reportState();
            return r;
          } catch (e) {
            return orig.call(this, state, title);
          }
        };
      });

      // Element URL properties set from JS (framework-inserted scripts,
      // images, iframes, stylesheets, media).
      function hook(Ctor, prop) {
        if (!Ctor) return;
        var d = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
        if (!d || !d.set) return;
        Object.defineProperty(Ctor.prototype, prop, {
          configurable: true,
          enumerable: d.enumerable,
          get: d.get,
          set: function (v) { return d.set.call(this, prox(v)); },
        });
      }
      hook(win.HTMLScriptElement, 'src');
      hook(win.HTMLImageElement, 'src');
      hook(win.HTMLIFrameElement, 'src');
      hook(win.HTMLEmbedElement, 'src');
      hook(win.HTMLSourceElement, 'src');
      hook(win.HTMLTrackElement, 'src');
      hook(win.HTMLMediaElement, 'src');
      hook(win.HTMLVideoElement, 'poster');
      hook(win.HTMLLinkElement, 'href');
      hook(win.HTMLFormElement, 'action');

      var URL_ATTRS = { src: 1, href: 1, action: 1, poster: 1 };
      var origSetAttr = win.Element.prototype.setAttribute;
      win.Element.prototype.setAttribute = function (name, value) {
        var n = String(name).toLowerCase();
        // <a href> is left alone so SPA routers still see the paths they
        // wrote; outbound clicks are handled by the click listener below.
        if (URL_ATTRS[n] && this.namespaceURI === 'http://www.w3.org/1999/xhtml' && this.tagName !== 'A') {
          value = prox(value);
        }
        return origSetAttr.call(this, name, value);
      };

      // Same-origin child frames (typically about:blank) get the same
      // treatment the moment the page reaches into them. In the sandbox
      // Chrome can give a page's own blank helper frames a separate opaque
      // origin, so reaching into them throws -- and apps that make them to
      // fetch "clean" built-ins (YouTube) crash on start. For those, hand
      // back a stand-in exposing this window's built-ins with a detached
      // document, so nothing written into it can touch the real page.
      function isBlankFrame(iframe) {
        var src = iframe.getAttribute('src');
        return !iframe.hasAttribute('srcdoc') && (!src || /^about:blank/i.test(src));
      }
      function hookFrameAccess(Ctor, prop, toWin) {
        if (!Ctor) return;
        var d = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
        if (!d || !d.get) return;
        Object.defineProperty(Ctor.prototype, prop, {
          configurable: true,
          enumerable: d.enumerable,
          get: function () {
            var v = d.get.call(this);
            try {
              var w = v && toWin(v);
              if (w && !w.__nbShim) install(w);
            } catch (e) {
              // Cross-origin: nothing to patch.
              if (prop === 'contentWindow' && v && isBlankFrame(this)) return blankFrameStandIn(win);
            }
            return v;
          },
        });
      }
      hookFrameAccess(win.HTMLIFrameElement, 'contentWindow', function (w) { return w; });
      hookFrameAccess(win.HTMLIFrameElement, 'contentDocument', function (d) { return d.defaultView; });
    }

    install(window);

    // --- Keep form input out of the real browser ------------------------------
    // No autofill/password-manager capture and no cloud spell-check of what
    // is typed into proxied pages.
    function privatizeFields(root) {
      if (!root || !root.querySelectorAll) return;
      var els = root.querySelectorAll('input, textarea, select, form, [contenteditable]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.tagName === 'FORM') {
          el.setAttribute('autocomplete', 'off');
          continue;
        }
        el.setAttribute('spellcheck', 'false');
        if (el.tagName !== 'SELECT' && !el.isContentEditable) {
          el.setAttribute('autocomplete', el.type === 'password' ? 'new-password' : 'off');
        }
      }
    }
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches('input, textarea, select, form, [contenteditable]')) privatizeFields(n.parentNode);
          else privatizeFields(n);
        }
      }
    }).observe(document, { childList: true, subtree: true });

    // --- Links -------------------------------------------------------------------

    // Links/forms created by JS that point at another site would navigate
    // the frame straight off the proxy. Root-relative ones are fine -- the
    // server-side stray fallback catches them.
    function fixNav(el, attr) {
      try {
        var v = el[attr];
        if (!v) return;
        var abs = new URL(v, document.baseURI);
        if (abs.protocol + '//' + abs.host !== HOST_ORIGIN) el[attr] = prox(v);
      } catch (e) {}
    }
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[href]');
      if (a) fixNav(a, 'href');
    }, true);
    document.addEventListener('submit', function (e) {
      if (e.target && e.target.tagName === 'FORM') fixNav(e.target, 'action');
    }, true);

    // Links meant for a new window (target=_blank, Ctrl/Cmd/middle click)
    // become tabs. Bubble phase on window, so a page that handles the
    // click itself (and calls preventDefault) keeps working as designed.
    function newTabClick(e) {
      if (e.defaultPrevented) return;
      var a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      var wantsNew = a.target === '_blank' || e.ctrlKey || e.metaKey || e.button === 1;
      if (!wantsNew || e.shiftKey) return;
      var href = a.getAttribute('href');
      if (!href || href.charAt(0) === '#' || /^(javascript|mailto|tel):/i.test(href)) return;
      if (openAsTab(prox(a.href))) e.preventDefault();
    }
    window.addEventListener('click', newTabClick);
    window.addEventListener('auxclick', function (e) { if (e.button === 1) newTabClick(e); });

    // --- Tab state for the browser UI ------------------------------------------
    // Only the page shown in a tab reports (not ads/embeds inside it), and
    // only its address, title and icon.

    var lastReport = '';
    function reportState() {
      if (!isTabRoot) return;
      var icon = document.querySelector('link[rel~="icon"][href], link[rel="shortcut icon"][href]');
      var msg = {
        nb: 'state',
        url: currentTarget(),
        title: (document.title || '').trim().slice(0, 300),
        icon: icon ? icon.getAttribute('href') : null,
      };
      if (msg.icon) {
        try {
          var abs = new URL(msg.icon, document.baseURI);
          msg.icon = abs.pathname + abs.search;
        } catch (e) { msg.icon = null; }
      }
      var key = JSON.stringify(msg);
      if (key === lastReport) return;
      lastReport = key;
      toUI(msg);
    }

    if (isTabRoot) {
      window.addEventListener('message', function (e) {
        if (e.source !== window.parent || !e.data || typeof e.data.nb !== 'string') return;
        if (e.data.nb === 'stop') window.stop();
      });
      document.addEventListener('DOMContentLoaded', function () {
        privatizeFields(document);
        reportState();
        var head = document.head || document.documentElement;
        new MutationObserver(reportState).observe(head, { childList: true, subtree: true, characterData: true });
      });
      window.addEventListener('load', reportState);
      window.addEventListener('popstate', reportState);
      window.addEventListener('hashchange', reportState);
      window.addEventListener('pagehide', function () { toUI({ nb: 'leaving' }); });
      reportState();
    } else {
      document.addEventListener('DOMContentLoaded', function () { privatizeFields(document); });
    }
  };
}

function buildShimTag() {
  return `<script data-nb-shim>(${shimSource().toString()})();</script>`;
}

module.exports = { buildShimTag };
