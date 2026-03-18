import { BrowserBoxClient } from './browserbox-client.js';

const SESSION_PHASE = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  READY: 'ready',
  ERROR: 'error',
});

const BROWSER_MODE = Object.freeze({
  INTERNAL: 'internal',
  EXTERNAL: 'external',
});

const INTERNAL_PAGES = new Set([
  'welcome',
  'whats-new',
  'whats-cool',
  'questions',
  'net-directory',
  'net-news',
  'about',
]);

const VERSION_KEY = 'cde-app-version';
const PENDING_UPDATE_KEY = 'cde-pending-update';
const DEBIAN_APP_VERSION = '1.0.32';
const BBX_HOME_URL = 'https://browserbox.io/';

const state = {
  client: new BrowserBoxClient(''),
  sessionPhase: SESSION_PHASE.IDLE,
  session: null,
  sessionPromise: null,
  webview: null,
  webviewWired: false,
  browserMode: BROWSER_MODE.INTERNAL,
  disconnectNotified: false,
  patchedNetscape: false,
  patchedLynx: false,
  navigationToken: 0,
};

primeDebianRuntime();

async function boot() {
  try {
    await onDomReady();
    await waitFor(() => window.Netscape && !window.Netscape.isStub, { label: 'Netscape' });
    patchNetscape(window.Netscape);

    await waitFor(() => window.Lynx && !window.Lynx.isStub, { label: 'Lynx' });
    patchLynx(window.Lynx);

    patchBrowserLauncher();
  } catch (error) {
    console.error('[debian-bbx] boot failed', error);
  }
}

void boot();

window.addEventListener('pagehide', () => {
  void notifyDisconnect();
});

window.addEventListener('beforeunload', () => {
  void notifyDisconnect();
});

function primeDebianRuntime() {
  try {
    localStorage.setItem(VERSION_KEY, DEBIAN_APP_VERSION);
    localStorage.removeItem(PENDING_UPDATE_KEY);
  } catch (error) {
    console.warn('[debian-bbx] version guard unavailable', error);
  }

  if (!window.browserSessionState || typeof window.browserSessionState !== 'object') {
    window.browserSessionState = { phase: SESSION_PHASE.IDLE, session: null };
  }

  if (!('serviceWorker' in navigator) || !navigator.serviceWorker?.register) {
    return;
  }

  const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
  navigator.serviceWorker.register = (...args) => {
    const [scriptUrl] = args;
    const shouldBlock = typeof scriptUrl === 'string' && scriptUrl.endsWith('/sw.js');
    if (shouldBlock) {
      console.info('[debian-bbx] blocked local service worker registration', { scriptUrl });
      return Promise.resolve({
        active: navigator.serviceWorker.controller || null,
        installing: null,
        waiting: null,
        scope: '/',
        update: async () => {},
        unregister: async () => true,
        addEventListener: () => {},
        removeEventListener: () => {},
      });
    }
    return register(...args);
  };
}

function setBrowserSessionState(phase, session = null) {
  state.sessionPhase = phase;
  state.session = session;
  window.browserSessionState = {
    phase,
    session,
  };
}

function onDomReady() {
  if (document.readyState !== 'loading') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    document.addEventListener('DOMContentLoaded', resolve, { once: true });
  });
}

async function waitFor(predicate, {
  timeoutMs = 20000,
  intervalMs = 100,
  label = 'condition',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await sleep(intervalMs);
  }
  throw new Error(`[debian-bbx] timed out waiting for ${label}`);
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getElement(id) {
  return document.getElementById(id);
}

function normalizeLoginLink(rawLoginLink) {
  if (typeof rawLoginLink !== 'string' || rawLoginLink.trim().length === 0) {
    return '';
  }

  try {
    const parsed = new URL(rawLoginLink, window.location.href);
    parsed.searchParams.set('ui', 'false');
    return parsed.href;
  } catch {
    return rawLoginLink.trim();
  }
}

function getNetscapeWindow() {
  return getElement('netscape');
}

function getNetscapeTitle() {
  return getNetscapeWindow()?.querySelector('.titlebar-text') || null;
}

function getAddressInput() {
  return getElement('nsUrlInput');
}

function getContentPane() {
  return getElement('nsContent');
}

function getStatusText() {
  return getElement('nsStatusText');
}

function getProgressBar() {
  return getElement('nsProgressBar');
}

function getBackButton() {
  return getElement('ns-btn-back');
}

function getForwardButton() {
  return getElement('ns-btn-forward');
}

function setTitle(text) {
  const title = getNetscapeTitle();
  if (title) {
    title.textContent = text;
  }
}

function setAddress(value) {
  const input = getAddressInput();
  if (input) {
    input.value = value;
  }
}

function setStatus(text, progress = null) {
  const statusText = getStatusText();
  if (statusText) {
    statusText.textContent = text;
  }
  if (typeof progress === 'number') {
    const bar = getProgressBar();
    if (bar) {
      bar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    }
  }
}

function setNavState({ canGoBack = false, canGoForward = false } = {}) {
  const back = getBackButton();
  const forward = getForwardButton();
  if (back) {
    back.disabled = !canGoBack;
  }
  if (forward) {
    forward.disabled = !canGoForward;
  }
}

function activateInternalSurface() {
  state.browserMode = BROWSER_MODE.INTERNAL;
  const content = getContentPane();
  const webview = ensureWebviewElement();
  if (content) {
    content.style.display = 'block';
  }
  if (webview) {
    webview.style.display = 'none';
  }
}

function activateExternalSurface() {
  state.browserMode = BROWSER_MODE.EXTERNAL;
  const content = getContentPane();
  const webview = ensureWebviewElement();
  if (content) {
    content.style.display = 'none';
  }
  if (webview) {
    webview.style.display = 'block';
  }
}

function ensureWebviewElement() {
  if (state.webview && document.body.contains(state.webview)) {
    return state.webview;
  }

  const existing = getElement('nsExternalView');
  if (!existing) {
    return null;
  }

  if (existing.tagName.toLowerCase() === 'browserbox-webview') {
    state.webview = existing;
    wireWebviewEvents(existing);
    return existing;
  }

  const webview = document.createElement('browserbox-webview');
  webview.id = 'nsExternalView';
  webview.className = existing.className;
  webview.style.cssText = existing.getAttribute('style') || 'display:none;';
  webview.style.width = '100%';
  webview.style.height = '100%';
  webview.setAttribute('title', existing.getAttribute('title') || 'Netscape BrowserBox View');
  webview.setAttribute('width', '100%');
  webview.setAttribute('height', '100%');
  webview.setAttribute('interaction-mode', 'full');
  webview.setAttribute('capture', 'sampled');
  webview.setAttribute('ui-visible', 'false');
  webview.setAttribute('allow-user-toggle-ui', 'false');
  webview.setAttribute('request-timeout-ms', '45000');
  webview._iframeRetryPingThreshold = 30;
  webview._iframeRetryMax = 2;
  existing.replaceWith(webview);

  state.webview = webview;
  wireWebviewEvents(webview);
  return webview;
}

function wireWebviewEvents(webview) {
  if (state.webviewWired) {
    return;
  }

  webview.addEventListener('ready', () => {
    setStatus('BrowserBox connected.', 20);
  });

  webview.addEventListener('api-ready', () => {
    setStatus('BrowserBox ready.', 25);
    void refreshBrowserState();
  });

  webview.addEventListener('did-start-loading', () => {
    setStatus('Loading...', 40);
  });

  webview.addEventListener('did-stop-loading', () => {
    setStatus('Document: Done', 100);
    window.setTimeout(() => {
      if (state.browserMode === BROWSER_MODE.EXTERNAL) {
        setStatus('Document: Done', 0);
      }
    }, 300);
    void refreshBrowserState();
  });

  webview.addEventListener('did-navigate', (event) => {
    const url = event.detail?.url;
    if (typeof url === 'string' && url.length > 0) {
      activateExternalSurface();
      setAddress(url);
    }
    void refreshBrowserState();
  });

  webview.addEventListener('active-tab-changed', () => {
    void refreshBrowserState();
  });

  webview.addEventListener('tab-updated', () => {
    void refreshBrowserState();
  });

  webview.addEventListener('disconnected', (event) => {
    if (event.detail?.reason === 'login-link-changed') {
      return;
    }
    setBrowserSessionState(SESSION_PHASE.IDLE, null);
    state.disconnectNotified = false;
    setStatus('BrowserBox disconnected.', 0);
  });

  state.webviewWired = true;
}

async function ensureBrowserSession({ interactive } = { interactive: true }) {
  if (state.sessionPhase === SESSION_PHASE.READY && state.session?.loginUrl) {
    return state.session;
  }

  if (state.sessionPromise) {
    return state.sessionPromise;
  }

  state.sessionPromise = (async () => {
    setBrowserSessionState(SESSION_PHASE.STARTING, state.session);

    if (!(await ensureReachable(interactive))) {
      setBrowserSessionState(SESSION_PHASE.IDLE, null);
      return null;
    }

    const existing = await state.client.checkSession().catch((error) => {
      console.warn('[debian-bbx] session status failed', error);
      return { active: false };
    });

    const session = existing?.active && existing?.loginUrl
      ? existing
      : await state.client.createSession({});

    if (!session?.loginUrl) {
      throw new Error('BrowserBox session response missing loginUrl');
    }

    session.loginUrl = normalizeLoginLink(session.loginUrl);
    setBrowserSessionState(SESSION_PHASE.READY, session);
    state.disconnectNotified = false;
    return session;
  })().catch((error) => {
    console.error('[debian-bbx] session setup failed', error);
    setBrowserSessionState(SESSION_PHASE.ERROR, null);
    if (interactive) {
      void showNotice(
        'BrowserBox could not start a browsing session for Debian Time Capsule.',
      );
    }
    return null;
  }).finally(() => {
    state.sessionPromise = null;
  });

  return state.sessionPromise;
}

async function ensureReachable(interactive) {
  if (!interactive) {
    return navigator.onLine !== false;
  }

  if (
    window.PerfectSaasOfflineShell
    && typeof window.PerfectSaasOfflineShell.ensureOnlineOrModal === 'function'
  ) {
    return window.PerfectSaasOfflineShell.ensureOnlineOrModal({
      appName: 'Debian Time Capsule',
      body: 'Debian Time Capsule cannot reach BrowserBox right now.',
      detail: 'Reconnect to the internet and this page will reload automatically.',
    });
  }

  return navigator.onLine !== false;
}

async function ensureWebviewConnected({ interactive } = { interactive: true }) {
  const session = await ensureBrowserSession({ interactive });
  if (!session?.loginUrl) {
    return null;
  }

  const webview = ensureWebviewElement();
  if (!webview) {
    throw new Error('Netscape BrowserBox mount is missing');
  }

  if (webview.getAttribute('login-link') !== session.loginUrl) {
    webview.setAttribute('login-link', session.loginUrl);
  }

  webview.style.display = 'block';
  if (!(await isWebviewUsable(webview))) {
    await webview.whenReady();
  }
  return webview;
}

async function isWebviewUsable(webview) {
  if (!webview || typeof webview.getTabs !== 'function') {
    return false;
  }

  try {
    await webview.getTabs();
    return true;
  } catch {
    return false;
  }
}

async function refreshBrowserState() {
  if (state.browserMode !== BROWSER_MODE.EXTERNAL || !state.webview) {
    return;
  }

  try {
    const tabs = await state.webview.getTabs();
    const activeTab = tabs.find((tab) => tab.active) || tabs[0];
    if (!activeTab) {
      return;
    }

    const title = activeTab.title || activeTab.url || 'BrowserBox';
    setTitle(`${title} — Netscape Navigator — BrowserBox`);
    if (activeTab.url) {
      setAddress(activeTab.url);
    }
    setNavState({
      canGoBack: Boolean(activeTab.canGoBack),
      canGoForward: Boolean(activeTab.canGoForward),
    });
  } catch (error) {
    console.warn('[debian-bbx] failed to refresh BrowserBox tab state', error);
  }
}

function normalizeTarget(rawTarget) {
  if (typeof rawTarget !== 'string') {
    return '';
  }

  let target = rawTarget.trim();
  if (!target) {
    return '';
  }

  if (target.startsWith('netscape:')) {
    target = target.slice('netscape:'.length);
  }

  if (target === 'net-search') {
    return 'https://duckduckgo.com/';
  }

  if (INTERNAL_PAGES.has(target)) {
    return target;
  }

  if (target === 'about:blank') {
    return target;
  }

  if (target.startsWith('about:')) {
    return 'about';
  }

  if (!target.includes('.') || target.includes(' ')) {
    return `https://duckduckgo.com/?q=${encodeURIComponent(target)}`;
  }

  if (target.startsWith('http://') || target.startsWith('https://')) {
    return target;
  }

  return `https://${target}`;
}

function isInternalTarget(target) {
  return INTERNAL_PAGES.has(target);
}

function shouldBootstrapToBrowserBox(netscape) {
  if (state.browserMode === BROWSER_MODE.EXTERNAL) {
    return false;
  }

  if (String(netscape?.currentPage || '') === 'whats-new') {
    return true;
  }

  const addressValue = getAddressInput()?.value?.trim() || '';
  return (
    addressValue === 'netscape:whats-new'
    || addressValue === 'http://home.netscape.com/home/whats-new.html'
    || addressValue === 'https://home.netscape.com/home/whats-new.html'
  );
}

function beginNavigationRequest() {
  state.navigationToken += 1;
  return state.navigationToken;
}

function isCurrentNavigationRequest(token) {
  return token === state.navigationToken;
}

async function navigateExternal(target) {
  const url = normalizeTarget(target);
  const navigationToken = beginNavigationRequest();
  const webview = await ensureWebviewConnected({ interactive: true });
  if (!webview || !isCurrentNavigationRequest(navigationToken)) {
    return;
  }

  activateExternalSurface();
  setTitle(`Connecting — Netscape Navigator — BrowserBox`);
  setAddress(url);
  setStatus(`Connecting to ${url}...`, 15);

  try {
    await webview.navigateTo(url);
    if (!isCurrentNavigationRequest(navigationToken)) {
      return;
    }
    await refreshBrowserState();
  } catch (error) {
    console.error('[debian-bbx] external navigation failed', { url, error });
    if (
      window.PerfectSaasOfflineShell
      && typeof window.PerfectSaasOfflineShell.noteNetworkFailure === 'function'
      && window.PerfectSaasOfflineShell.noteNetworkFailure(error, {
        appName: 'Debian Time Capsule',
        body: 'Debian Time Capsule lost its BrowserBox connection.',
        detail: 'Reconnect to the internet and this page will reload automatically.',
      })
    ) {
      return;
    }
    setStatus(`Navigation failed: ${url}`, 0);
    await showNotice(`BrowserBox could not navigate to ${url}.`);
  }
}

async function bootstrapBrowserBoxHomepage(netscape) {
  if (!shouldBootstrapToBrowserBox(netscape)) {
    return;
  }

  const navigationToken = beginNavigationRequest();
  const webview = await ensureWebviewConnected({ interactive: true });
  if (!webview || !isCurrentNavigationRequest(navigationToken)) {
    return;
  }

  if (!shouldBootstrapToBrowserBox(netscape)) {
    return;
  }

  activateExternalSurface();
  setAddress(BBX_HOME_URL);
  setStatus('Loading BrowserBox homepage...', 20);

  try {
    await webview.navigate(BBX_HOME_URL);
    if (!isCurrentNavigationRequest(navigationToken)) {
      return;
    }
    await refreshBrowserState();
  } catch (error) {
    console.error('[debian-bbx] startup navigation failed', error);
    setStatus(`Navigation failed: ${BBX_HOME_URL}`, 0);
  }
}

function patchNetscape(netscape) {
  if (state.patchedNetscape) {
    return;
  }

  const original = {
    close: netscape.close.bind(netscape),
    findInPage: netscape.findInPage.bind(netscape),
    goBack: netscape.goBack.bind(netscape),
    goForward: netscape.goForward.bind(netscape),
    goHome: netscape.goHome.bind(netscape),
    handleUrlKey: netscape.handleUrlKey.bind(netscape),
    loadImages: netscape.loadImages.bind(netscape),
    navigate: netscape.navigate.bind(netscape),
    newWindow: netscape.newWindow.bind(netscape),
    open: netscape.open.bind(netscape),
    openLocation: netscape.openLocation.bind(netscape),
    printPage: netscape.printPage.bind(netscape),
    reload: netscape.reload.bind(netscape),
    savePage: netscape.savePage.bind(netscape),
    stop: netscape.stop.bind(netscape),
    viewSource: netscape.viewSource.bind(netscape),
  };

  netscape.open = (...args) => {
    const result = original.open(...args);
    ensureWebviewElement();
    if (shouldBootstrapToBrowserBox(netscape)) {
      void bootstrapBrowserBoxHomepage(netscape);
    } else {
      void ensureBrowserSession({ interactive: false });
    }
    return result;
  };

  netscape.navigate = async (rawTarget) => {
    const target = normalizeTarget(rawTarget);
    if (!target) {
      return;
    }

    if (isInternalTarget(target)) {
      activateInternalSurface();
      setTitle('Netscape Navigator — victxrlarixs@debian');
      return original.navigate(target);
    }

    await navigateExternal(target);
  };

  netscape.goBack = async () => {
    if (state.browserMode !== BROWSER_MODE.EXTERNAL) {
      return original.goBack();
    }
    const webview = await ensureWebviewConnected({ interactive: true });
    if (!webview) {
      return;
    }
    await webview.goBack();
    await refreshBrowserState();
  };

  netscape.goForward = async () => {
    if (state.browserMode !== BROWSER_MODE.EXTERNAL) {
      return original.goForward();
    }
    const webview = await ensureWebviewConnected({ interactive: true });
    if (!webview) {
      return;
    }
    await webview.goForward();
    await refreshBrowserState();
  };

  netscape.goHome = async () => {
    await navigateExternal(BBX_HOME_URL);
  };

  netscape.reload = async () => {
    if (state.browserMode !== BROWSER_MODE.EXTERNAL) {
      return original.reload();
    }
    const webview = await ensureWebviewConnected({ interactive: true });
    if (!webview) {
      return;
    }
    setStatus('Reloading...', 20);
    await webview.reload();
  };

  netscape.stop = async () => {
    if (state.browserMode !== BROWSER_MODE.EXTERNAL) {
      return original.stop();
    }
    const webview = await ensureWebviewConnected({ interactive: true });
    if (!webview) {
      return;
    }
    await webview.stop();
    setStatus('Transfer interrupted.', 0);
  };

  netscape.handleUrlKey = (event) => {
    if (event.key !== 'Enter') {
      return original.handleUrlKey(event);
    }
    event.preventDefault();
    const value = event.target?.value || '';
    void netscape.navigate(value);
  };

  netscape.newWindow = (...args) => {
    const result = original.open(...args);
    void ensureBrowserSession({ interactive: false });
    return result;
  };

  netscape.loadImages = () => {
    if (state.browserMode !== BROWSER_MODE.EXTERNAL) {
      return original.loadImages();
    }
    setStatus('BrowserBox already renders page images.', 0);
  };

  netscape.findInPage = async () => {
    if (state.browserMode !== BROWSER_MODE.EXTERNAL) {
      return original.findInPage();
    }
    await showNotice('Find in page is not wired for the BrowserBox embed yet.');
  };

  netscape.viewSource = async () => {
    if (state.browserMode !== BROWSER_MODE.EXTERNAL) {
      return original.viewSource();
    }
    await showNotice('View Source is not wired for the BrowserBox embed yet.');
  };

  netscape.savePage = async () => {
    if (state.browserMode !== BROWSER_MODE.EXTERNAL) {
      return original.savePage();
    }
    await showNotice('Save Page is not wired for the BrowserBox embed yet.');
  };

  netscape.printPage = async () => {
    if (state.browserMode !== BROWSER_MODE.EXTERNAL) {
      return original.printPage();
    }
    await showNotice('Print is not wired for the BrowserBox embed yet.');
  };

  netscape.openLocation = (...args) => original.openLocation(...args);
  netscape.close = (...args) => original.close(...args);

  state.patchedNetscape = true;
  ensureWebviewElement();
  activateInternalSurface();
}

function patchLynx(lynx) {
  if (state.patchedLynx) {
    return;
  }

  lynx.open = async () => {
    if (window.Netscape?.open) {
      window.Netscape.open();
      setStatus('Use Netscape for BrowserBox-backed browsing.', 0);
      await showNotice('Lynx is disabled in this demo. Use Netscape for BrowserBox browsing.');
    }
  };

  state.patchedLynx = true;
}

function patchBrowserLauncher() {
  const browserControl = document.querySelector('.cde-control[aria-label="Github Repository"]');
  if (!browserControl) {
    return;
  }

  browserControl.removeAttribute('onclick');
  browserControl.onclick = null;
  browserControl.setAttribute('aria-label', 'Netscape Navigator');
  browserControl.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (window.Netscape?.open) {
      window.Netscape.open();
    }
  });
}

async function showNotice(message) {
  if (window.CDEModal && typeof window.CDEModal.alert === 'function') {
    return window.CDEModal.alert(message);
  }
  window.alert(message);
}

async function notifyDisconnect() {
  if (state.disconnectNotified || !state.session?.sessionId) {
    return;
  }
  state.disconnectNotified = true;
  await state.client.notifyDisconnect(state.session.sessionId, { mode: 'defer' });
}
