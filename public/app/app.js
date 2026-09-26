(() => {
  // The browser UI. Pages run in sandboxed, opaque-origin frames: this
  // code cannot read them, their input, or their storage. It only receives
  // what the page shim chooses to send (address, title, icon, "open in new
  // tab") and nothing is kept once this tab closes.

  const $ = (id) => document.getElementById(id);
  const tabsEl = $('tabs');
  const viewport = $('viewport');
  const form = $('navForm');
  const urlInput = $('url');
  const addrBtn = $('addrBtn');
  const addrHost = $('addrHost');
  const addrPath = $('addrPath');
  const addrInsecure = $('addrInsecure');
  const siteBadgeIcon = $('siteBadgeIcon');
  const command = $('command');
  const commandBackdrop = $('commandBackdrop');
  const routeChip = $('routeChip');
  const routeChipText = $('routeChipText');
  const backBtn = $('back');
  const forwardBtn = $('forward');
  const reloadBtn = $('reload');
  const reloadIcon = $('reloadIcon');
  const homeBtn = $('home');
  const newTabBtn = $('newTab');
  const progress = $('progress');
  const logsToggle = $('logsToggle');
  const endBtn = $('endBtn');
  const logsPanel = $('logsPanel');
  const logsClose = $('logsClose');
  const logsClear = $('logsClear');
  const logsBody = $('logsBody');
  const ntpTemplate = $('newTabTemplate');

  const SEARCH_URL = 'https://html.duckduckgo.com/html/?q=';
  const FRAME_SANDBOX = 'allow-scripts allow-forms allow-modals allow-pointer-lock allow-presentation';

  let token = '';

  // --- URL helpers (mirror src/proxyUrl.js) -------------------------------

  function proxyUrlFor(targetUrl) {
    const u = new URL(targetUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported');
    return '/p/' + token + '/' + u.protocol.slice(0, -1) + '/' + u.host + u.pathname + u.search + u.hash;
  }

  function isOwnProxyPath(p) {
    return typeof p === 'string' && p.startsWith('/p/' + token + '/');
  }

  function targetFromProxyPath(p) {
    if (!isOwnProxyPath(p)) return null;
    const m = p.slice(('/p/' + token + '/').length).match(/^(https?)\/([^/?#]+)(.*)$/);
    if (!m) return null;
    return m[1] + '://' + m[2] + (m[3] && m[3].startsWith('/') ? m[3] : '/' + (m[3] || ''));
  }

  // Address-bar input -> URL: things that look like addresses load
  // directly, anything else becomes a search.
  function resolveInput(input) {
    const value = input.trim();
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    if (!/\s/.test(value) && (/^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(value) || /^localhost(:\d+)?(\/|$)/i.test(value))) {
      return 'https://' + value;
    }
    return SEARCH_URL + encodeURIComponent(value);
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch (e) {
      return '';
    }
  }

  function faviconFallback(url) {
    try {
      return proxyUrlFor(new URL(url).origin + '/favicon.ico');
    } catch (e) {
      return null;
    }
  }

  // --- Tabs ---------------------------------------------------------------

  let tabs = [];
  let activeTab = null;
  let nextId = 1;

  function createTab(url, { activate = true, index } = {}) {
    const tab = {
      id: nextId++,
      url: '',
      title: 'New tab',
      favicon: null,
      loading: false,
      pendingNav: false,
      history: [],
      index: -1,
      frame: null,
      ntp: null,
      el: null,
    };
    tab.el = buildTabEl(tab);
    if (index == null || index >= tabs.length) {
      tabs.push(tab);
      tabsEl.appendChild(tab.el);
    } else {
      tabs.splice(index, 0, tab);
      tabsEl.insertBefore(tab.el, tabsEl.children[index]);
    }
    if (url) navigate(tab, url);
    else showNewTabPage(tab);
    if (activate) activateTab(tab);
    else renderTab(tab);
    return tab;
  }

  function buildTabEl(tab) {
    const el = document.createElement('div');
    el.className = 'tab';
    el.setAttribute('role', 'tab');
    el.tabIndex = 0;
    el.innerHTML =
      '<span class="tab-icon"></span>' +
      '<span class="tab-title"></span>' +
      '<button class="icon-btn tab-close" aria-label="Close tab" title="Close tab (Alt+W)"><svg><use href="#i-close"/></svg></button>';
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tab);
      } else if (e.button === 0 && !e.target.closest('.tab-close')) {
        activateTab(tab);
      }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateTab(tab);
      }
    });
    el.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab);
    });
    return el;
  }

  function renderTab(tab) {
    const el = tab.el;
    el.classList.toggle('active', tab === activeTab);
    el.setAttribute('aria-selected', String(tab === activeTab));
    el.title = tab.title + (tab.url ? '\n' + hostOf(tab.url) : '');
    el.querySelector('.tab-title').textContent = tab.title;

    const icon = el.querySelector('.tab-icon');
    const key = tab.loading ? 'loading' : tab.favicon || (tab.url ? 'globe' : 'blank');
    if (icon.dataset.key !== key) {
      icon.dataset.key = key;
      if (tab.loading) {
        icon.innerHTML = '<span class="tab-spinner" aria-label="Loading"></span>';
      } else if (tab.favicon) {
        const img = new Image();
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.src = tab.favicon;
        img.onerror = () => {
          icon.innerHTML = '<svg><use href="#i-globe"/></svg>';
        };
        icon.replaceChildren(img);
      } else if (tab.url) {
        icon.innerHTML = '<svg><use href="#i-globe"/></svg>';
      } else {
        icon.innerHTML = '';
      }
    }
    if (tab === activeTab) renderToolbar();
  }

  function activateTab(tab) {
    if (activeTab === tab) return;
    const prev = activeTab;
    activeTab = tab;
    for (const t of tabs) {
      const visible = t === tab;
      if (t.frame) t.frame.hidden = !visible || !t.url;
      if (t.ntp) t.ntp.hidden = !visible;
    }
    if (prev) renderTab(prev);
    renderTab(tab);
    tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (!tab.url) focusNtp(tab);
  }

  function closeTab(tab) {
    const i = tabs.indexOf(tab);
    if (i === -1) return;
    tabs.splice(i, 1);
    tab.el.remove();
    discardFrame(tab);
    if (tab.ntp) tab.ntp.remove();
    if (!tabs.length) {
      createTab();
      return;
    }
    if (activeTab === tab) {
      activeTab = null;
      activateTab(tabs[Math.min(i, tabs.length - 1)]);
    }
  }

  function discardFrame(tab) {
    if (!tab.frame) return;
    // Blank it first so the page gets its unload and stops all activity.
    try {
      tab.frame.src = 'about:blank';
    } catch (e) {}
    tab.frame.remove();
    tab.frame = null;
  }

  function tabForSource(source) {
    // Walk up from the sending window to the frame that's one of our tabs;
    // an ad or embed inside a page reports through its tab page's frame.
    let w = source;
    for (let depth = 0; w && depth < 10; depth++) {
      for (const t of tabs) if (t.frame && t.frame.contentWindow === w) return t;
      let parent;
      try {
        parent = w.parent;
      } catch (e) {
        return null;
      }
      if (!parent || parent === w || parent === window) break;
      w = parent;
    }
    return null;
  }

  // --- Navigation ---------------------------------------------------------

  function ensureFrame(tab) {
    if (tab.frame) return tab.frame;
    const frame = document.createElement('iframe');
    frame.className = 'tab-frame';
    frame.title = 'Page content';
    frame.setAttribute('sandbox', FRAME_SANDBOX);
    frame.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media');
    frame.setAttribute('allowfullscreen', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.hidden = tab !== activeTab;
    // Inserting an iframe fires `load` for its blank document right away,
    // so tab.frame must already be set and the handler told which frame.
    tab.frame = frame;
    frame.addEventListener('load', () => {
      if (tab.frame !== frame || !tab.url) return;
      tab.loading = false;
      renderTab(tab);
    });
    viewport.insertBefore(frame, viewport.firstChild);
    return frame;
  }

  function navigate(tab, input, { fromHistory = false } = {}) {
    const url = resolveInput(input);
    if (!url) return;
    let proxied;
    try {
      proxied = proxyUrlFor(url);
    } catch (e) {
      return;
    }

    if (!fromHistory) {
      tab.history = tab.history.slice(0, tab.index + 1);
      tab.history.push(url);
      tab.index = tab.history.length - 1;
    }
    tab.url = url;
    tab.title = hostOf(url) || url;
    tab.favicon = null;
    tab.loading = true;
    // The load this starts may end on a different URL (site redirects);
    // that final URL replaces this history entry rather than adding one.
    tab.pendingNav = true;
    hideNewTabPage(tab);

    const frame = ensureFrame(tab);
    frame.hidden = tab !== activeTab;
    // location.replace() keeps navigations out of the top-level session
    // history (shared by all tabs' frames); each tab keeps its own
    // back/forward list instead. Allowed on a cross-origin frame.
    try {
      if (frame.getAttribute('src')) frame.contentWindow.location.replace(proxied);
      else frame.src = proxied;
    } catch (e) {
      frame.src = proxied;
    }
    renderTab(tab);
  }

  function onPageState(tab, msg) {
    const url = typeof msg.url === 'string' && /^https?:\/\//i.test(msg.url) ? msg.url : null;
    if (url) {
      if (tab.pendingNav) {
        tab.history[tab.index] = url;
        tab.pendingNav = false;
      } else if (url !== tab.url && tab.history[tab.index] !== url) {
        tab.history = tab.history.slice(0, tab.index + 1);
        tab.history.push(url);
        tab.index = tab.history.length - 1;
      }
      tab.url = url;
    }
    if (typeof msg.title === 'string') tab.title = msg.title.trim() || hostOf(tab.url) || 'Untitled';
    tab.favicon = isOwnProxyPath(msg.icon) ? msg.icon : faviconFallback(tab.url);
    renderTab(tab);
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg.nb !== 'string') return;
    const tab = tabForSource(e.source);
    if (!tab) return;
    const fromTabRoot = tab.frame && e.source === tab.frame.contentWindow;

    if (msg.nb === 'expired') {
      endLocally();
    } else if (msg.nb === 'open' && typeof msg.path === 'string') {
      const target = targetFromProxyPath(msg.path);
      if (target) createTab(target, { index: tabs.indexOf(tab) + 1 });
    } else if (fromTabRoot && msg.nb === 'state') {
      onPageState(tab, msg);
    } else if (fromTabRoot && msg.nb === 'leaving') {
      tab.loading = true;
      renderTab(tab);
    }
  });

  function goBack() {
    const tab = activeTab;
    if (!tab || tab.index <= 0) return;
    tab.index -= 1;
    navigate(tab, tab.history[tab.index], { fromHistory: true });
  }

  function goForward() {
    const tab = activeTab;
    if (!tab || tab.index >= tab.history.length - 1) return;
    tab.index += 1;
    navigate(tab, tab.history[tab.index], { fromHistory: true });
  }

  function reloadOrStop() {
    const tab = activeTab;
    if (!tab || !tab.frame || !tab.url) return;
    if (tab.loading) {
      try {
        tab.frame.contentWindow.postMessage({ nb: 'stop' }, '*');
      } catch (e) {}
      tab.loading = false;
      renderTab(tab);
    } else {
      navigate(tab, tab.url, { fromHistory: true });
    }
  }

  function goHome() {
    const tab = activeTab;
    if (!tab) return;
    tab.url = '';
    tab.title = 'New tab';
    tab.favicon = null;
    tab.loading = false;
    discardFrame(tab);
    showNewTabPage(tab);
    renderTab(tab);
  }

  // --- New tab page -------------------------------------------------------

  let egressIp = null; // string once known, false if the check failed

  function showNewTabPage(tab) {
    if (tab.ntp) {
      tab.ntp.hidden = tab !== activeTab;
      renderNtp(tab);
      return;
    }
    const ntp = ntpTemplate.content.firstElementChild.cloneNode(true);
    ntp.hidden = tab !== activeTab;
    const input = ntp.querySelector('.ntp-search input');
    ntp.querySelector('.ntp-search').addEventListener('submit', (e) => {
      e.preventDefault();
      navigate(tab, input.value);
    });
    viewport.appendChild(ntp);
    tab.ntp = ntp;
    renderNtp(tab);
  }

  function hideNewTabPage(tab) {
    if (tab.ntp) {
      tab.ntp.remove();
      tab.ntp = null;
    }
  }

  function renderNtp(tab) {
    const ntp = tab.ntp;
    if (!ntp) return;
    const egressText = ntp.querySelector('.ntp-egress-text');
    if (egressIp) {
      egressText.innerHTML = 'Browsing from <strong></strong>';
      egressText.querySelector('strong').textContent = egressIp;
    } else if (egressIp === false) {
      egressText.textContent = 'Pages load through a remote server.';
    }
  }

  function focusNtp(tab) {
    if (!tab.ntp) return;
    requestAnimationFrame(() => {
      const input = tab.ntp && tab.ntp.querySelector('.ntp-search input');
      if (input && document.activeElement !== urlInput) input.focus();
    });
  }

  async function checkEgress() {
    try {
      const res = await fetch(proxyUrlFor('https://api.ipify.org/?format=json'), { referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      egressIp = String(data.ip);
      routeChipText.textContent = egressIp;
      routeChip.title = 'Pages load through a remote server with IP ' + egressIp;
    } catch (e) {
      egressIp = false;
    }
    for (const t of tabs) renderNtp(t);
  }

  // --- Toolbar ------------------------------------------------------------

  function renderToolbar() {
    const tab = activeTab;
    if (!tab) return;
    backBtn.disabled = tab.index <= 0;
    forwardBtn.disabled = tab.index >= tab.history.length - 1;
    reloadBtn.disabled = !tab.url;
    reloadIcon.setAttribute('href', tab.loading ? '#i-stop' : '#i-reload');
    reloadBtn.title = tab.loading ? 'Stop loading' : 'Reload (Ctrl+R)';
    reloadBtn.setAttribute('aria-label', tab.loading ? 'Stop' : 'Reload');
    progress.hidden = !tab.loading;

    renderAddress(tab.url);
  }

  // The address card: host on top, path below, lock or "Not secure".
  function renderAddress(url) {
    let u = null;
    try {
      u = url ? new URL(url) : null;
    } catch (e) {}
    addrBtn.classList.toggle('empty', !u);
    addrBtn.classList.toggle('secure', !!u && u.protocol === 'https:');
    addrBtn.classList.toggle('insecure', !!u && u.protocol === 'http:');
    if (!u) {
      siteBadgeIcon.setAttribute('href', '#i-search');
      addrHost.textContent = 'Go to…';
      addrPath.hidden = true;
      addrInsecure.hidden = true;
      addrBtn.title = 'Go to an address (Ctrl+L)';
      return;
    }
    siteBadgeIcon.setAttribute('href', u.protocol === 'https:' ? '#i-lock' : '#i-warn');
    addrHost.textContent = u.host.replace(/^www\./, '');
    const tail = u.pathname + u.search + u.hash;
    addrPath.textContent = tail;
    addrPath.hidden = tail === '/';
    addrInsecure.hidden = u.protocol !== 'http:';
    addrBtn.title = url + '\n' + (u.protocol === 'https:' ? 'Encrypted connection (HTTPS)' : 'Connection is not encrypted (HTTP)') + '\nClick to go somewhere else (Ctrl+L)';
  }

  // --- "Go to" box -----------------------------------------------------------

  let lastFocus = null;

  function openCommand() {
    lastFocus = document.activeElement;
    command.hidden = false;
    urlInput.value = activeTab ? activeTab.url : '';
    urlInput.focus();
    urlInput.select();
  }

  function closeCommand({ restoreFocus = true } = {}) {
    if (command.hidden) return;
    command.hidden = true;
    if (restoreFocus && lastFocus && lastFocus.focus) lastFocus.focus();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!activeTab) return;
    const value = urlInput.value;
    closeCommand({ restoreFocus: false });
    navigate(activeTab, value);
    if (activeTab.frame) activeTab.frame.focus();
  });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCommand();
    }
  });
  commandBackdrop.addEventListener('mousedown', () => closeCommand());
  addrBtn.addEventListener('click', openCommand);

  backBtn.addEventListener('click', goBack);
  forwardBtn.addEventListener('click', goForward);
  reloadBtn.addEventListener('click', reloadOrStop);
  homeBtn.addEventListener('click', goHome);
  newTabBtn.addEventListener('click', () => createTab());
  tabsEl.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.tab, button')) createTab();
  });

  logsToggle.addEventListener('click', () => toggleLogs(logsPanel.hidden));
  endBtn.addEventListener('click', endSession);

  // --- Keyboard shortcuts --------------------------------------------------
  // Only while focus is in this UI: keys pressed inside a page never reach
  // it. Chrome keeps Ctrl+T / Ctrl+W / Ctrl+Tab for itself, so tab
  // shortcuts use Alt; Ctrl+L and Ctrl+R can be handled here.

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    let handled = true;
    if (e.altKey && !mod && key === 't') createTab();
    else if (e.altKey && !mod && key === 'w') activeTab && closeTab(activeTab);
    else if (e.altKey && !mod && /^[1-9]$/.test(e.key)) {
      const t = e.key === '9' ? tabs[tabs.length - 1] : tabs[Number(e.key) - 1];
      if (t) activateTab(t);
    } else if (e.altKey && e.key === 'ArrowLeft') goBack();
    else if (e.altKey && e.key === 'ArrowRight') goForward();
    else if ((mod && key === 'l') || e.key === 'F6') openCommand();
    else if ((mod && key === 'r') || e.key === 'F5') reloadOrStop();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // --- Request log ----------------------------------------------------------

  let logsTimer = null;

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  async function refreshLogs() {
    let entries;
    try {
      const res = await fetch('/api/logs');
      if (res.status === 401) return endLocally();
      if (!res.ok) throw new Error('HTTP ' + res.status);
      entries = await res.json();
    } catch (e) {
      logsBody.innerHTML = '<p class="logs-empty">Couldn’t load the request log: ' + escapeHtml(e.message) + '</p>';
      return;
    }
    if (!entries.length) {
      logsBody.innerHTML = '<p class="logs-empty">No requests in this session. The log is deleted when the session ends.</p>';
      return;
    }
    logsBody.innerHTML = entries.map((e) => {
      const time = new Date(e.time).toLocaleTimeString();
      const cls = e.kind === 'blocked' ? 'log-blocked' : e.ok ? 'log-ok' : 'log-fail';
      const statusText = e.kind === 'blocked' ? 'Blocked' : e.status != null ? e.status : (e.ok ? '' : 'ERR');
      return (
        '<div class="log-row ' + cls + '">' +
          '<div class="log-meta"><span class="log-status">' + escapeHtml(statusText) + '</span>' +
          '<span class="log-time">' + time + '</span>' +
          '<span class="log-duration">' + e.durationMs + ' ms</span></div>' +
          '<div class="log-url" title="' + escapeHtml(e.url || '') + '">' + escapeHtml(e.url || '') + '</div>' +
          (e.message && e.kind !== 'blocked' ? '<div class="log-message">' + escapeHtml(e.message) + '</div>' : '') +
        '</div>'
      );
    }).join('');
  }

  function toggleLogs(show) {
    if (show) {
      logsPanel.hidden = false;
      refreshLogs();
      if (!logsTimer) logsTimer = setInterval(refreshLogs, 3000);
    } else {
      logsPanel.hidden = true;
      clearInterval(logsTimer);
      logsTimer = null;
      logsBody.replaceChildren();
    }
  }
  logsClose.addEventListener('click', () => toggleLogs(false));
  logsClear.addEventListener('click', async () => {
    await fetch('/api/logs', { method: 'DELETE' }).catch(() => {});
    refreshLogs();
  });

  // --- Session lifetime -------------------------------------------------------

  let ending = false;

  // Tear down every page first, so nothing keeps running while we leave.
  function wipeUi() {
    for (const t of tabs) discardFrame(t);
    logsBody.replaceChildren();
  }

  function endLocally() {
    if (ending) return;
    ending = true;
    wipeUi();
    location.replace('/login');
  }

  async function endSession() {
    if (ending) return;
    ending = true;
    wipeUi();
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    location.replace('/login');
  }

  // Closing (or reloading) this tab ends the session: the server deletes
  // the session and its log; the sign-in page wipes browser-side data.
  window.addEventListener('pagehide', () => {
    if (ending) return;
    try {
      navigator.sendBeacon('/api/close');
    } catch (e) {}
  });

  // Notice promptly if the session ended elsewhere (idle timeout, sign
  // out in another window).
  setInterval(async () => {
    try {
      const res = await fetch('/api/session');
      if (res.status === 401) endLocally();
    } catch (e) {}
  }, 60 * 1000);

  // --- Start ----------------------------------------------------------------

  (async () => {
    try {
      const res = await fetch('/api/session');
      if (!res.ok) throw new Error('no session');
      token = (await res.json()).token;
    } catch (e) {
      endLocally();
      return;
    }
    createTab();
    checkEgress();
  })();
})();
