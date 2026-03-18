(function initPerfectSaasOfflineShell() {
  if (globalThis.PerfectSaasOfflineShell) {
    return;
  }

  const HEALTH_URL = '/health';
  const OVERLAY_ID = 'bbx-connectivity-overlay';
  const PROBE_TIMEOUT_MS = 8000;
  const PROBE_RETRY_MS = 1500;

  const state = {
    overlay: null,
    titleEl: null,
    bodyEl: null,
    detailEl: null,
    retryButton: null,
    probeTimer: 0,
    probePromise: null,
    reloadRequested: false,
    swBootstrapPromise: null,
  };

  function onDomReady(task) {
    if (document.body) {
      task();
      return;
    }
    window.addEventListener('DOMContentLoaded', task, { once: true });
  }

  function isLikelyNetworkFailure(error) {
    if (!error) return false;
    if (error.name === 'AbortError') return true;
    if (error.code === 'NETWORK_OFFLINE' || error.code === 'NETWORK_FETCH_FAILED') return true;

    const message = String(error.message || error).toLowerCase();
    return (
      message.includes('failed to fetch')
      || message.includes('networkerror')
      || message.includes('network request failed')
      || message.includes('load failed')
      || message.includes('offline')
    );
  }

  function clearProbeTimer() {
    if (!state.probeTimer) {
      return;
    }
    window.clearTimeout(state.probeTimer);
    state.probeTimer = 0;
  }

  function ensureOverlay() {
    if (state.overlay && document.body && document.body.contains(state.overlay)) {
      return state.overlay;
    }

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:none',
      'align-items:center',
      'justify-content:center',
      'padding:24px',
      'background:rgba(10,14,24,0.6)',
      'backdrop-filter:blur(2px)',
    ].join(';');

    const dialog = document.createElement('div');
    dialog.style.cssText = [
      'width:min(460px, calc(100vw - 32px))',
      'border:1px solid rgba(255,255,255,0.22)',
      'border-radius:14px',
      'background:linear-gradient(180deg, #161d2d 0%, #0e1522 100%)',
      'box-shadow:0 20px 60px rgba(0,0,0,0.45)',
      'color:#f5f7fb',
      'font-family:system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      'padding:20px 22px',
    ].join(';');

    const title = document.createElement('h2');
    title.style.cssText = 'margin:0 0 10px;font-size:20px;line-height:1.2;font-weight:700;';
    dialog.appendChild(title);

    const body = document.createElement('p');
    body.style.cssText = 'margin:0 0 10px;font-size:14px;line-height:1.55;color:#e7edf9;';
    dialog.appendChild(body);

    const detail = document.createElement('p');
    detail.style.cssText = 'margin:0 0 18px;font-size:12px;line-height:1.55;color:#a9b7d0;';
    dialog.appendChild(detail);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;';

    const retryButton = document.createElement('button');
    retryButton.type = 'button';
    retryButton.textContent = 'Retry Now';
    retryButton.style.cssText = [
      'appearance:none',
      'border:1px solid #8fb0ff',
      'border-radius:999px',
      'background:#8fb0ff',
      'color:#0d1730',
      'font:600 13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      'padding:9px 14px',
      'cursor:pointer',
    ].join(';');
    retryButton.addEventListener('click', () => {
      void runProbe('manual-retry');
    });
    actions.appendChild(retryButton);

    dialog.appendChild(actions);
    overlay.appendChild(dialog);

    state.overlay = overlay;
    state.titleEl = title;
    state.bodyEl = body;
    state.detailEl = detail;
    state.retryButton = retryButton;

    if (document.body) {
      document.body.appendChild(overlay);
    }

    return overlay;
  }

  function setOverlayContent({
    title = 'Internet Connection',
    body = 'BrowserBox cannot reach the internet right now.',
    detail = 'Reconnect to the internet and this page will reload automatically.',
    retryLabel = 'Retry Now',
    retryDisabled = false,
  } = {}) {
    onDomReady(() => {
      const overlay = ensureOverlay();
      if (!overlay) {
        return;
      }
      state.titleEl.textContent = title;
      state.bodyEl.textContent = body;
      state.detailEl.textContent = detail;
      state.retryButton.textContent = retryLabel;
      state.retryButton.disabled = Boolean(retryDisabled);
      state.retryButton.style.opacity = retryDisabled ? '0.55' : '1';
      state.retryButton.style.cursor = retryDisabled ? 'default' : 'pointer';
      overlay.style.display = 'flex';
    });
  }

  function showOfflineModal(options = {}) {
    setOverlayContent({
      title: options.title || 'Internet Connection',
      body: options.body || 'BrowserBox cannot reach the internet right now.',
      detail: options.detail || 'Reconnect to the internet and this page will reload automatically.',
      retryLabel: options.retryLabel || 'Retry Now',
      retryDisabled: options.retryDisabled || false,
    });
    return true;
  }

  function hideOfflineModal() {
    if (state.overlay) {
      state.overlay.style.display = 'none';
    }
  }

  async function probeHealth(url = HEALTH_URL) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let ok = false;

    try {
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      ok = response.ok;
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.warn('[offline-shell] health probe failed', error);
      }
    } finally {
      window.clearTimeout(timeoutId);
    }

    return ok;
  }

  function requestReload(reason = 'connectivity-restored') {
    if (state.reloadRequested) {
      return false;
    }

    state.reloadRequested = true;
    clearProbeTimer();
    console.info('[offline-shell] reloading page', { reason });
    window.location.reload();
    return true;
  }

  function scheduleProbe(trigger = 'retry') {
    if (state.reloadRequested || state.probeTimer) {
      return;
    }

    state.probeTimer = window.setTimeout(() => {
      state.probeTimer = 0;
      void runProbe(trigger);
    }, PROBE_RETRY_MS);
  }

  async function runProbe(trigger = 'online-event') {
    if (state.reloadRequested) {
      return true;
    }
    if (state.probePromise) {
      return state.probePromise;
    }

    state.probePromise = (async () => {
      if (navigator.onLine === false) {
        showOfflineModal();
        return false;
      }

      showOfflineModal({
        body: 'Connection restored. Verifying BrowserBox availability...',
        detail: 'Reloading as soon as the BrowserBox shell responds again.',
        retryDisabled: true,
      });

      const healthy = await probeHealth();
      if (healthy) {
        showOfflineModal({
          body: 'Connection restored. Reloading now...',
          detail: 'BrowserBox is reachable again.',
          retryDisabled: true,
        });
        requestReload(`connectivity:${trigger}`);
        return true;
      }

      showOfflineModal({
        body: 'The internet connection returned, but BrowserBox is still unreachable.',
        detail: 'Waiting for the server probe to succeed before reloading.',
      });
      scheduleProbe('probe-retry');
      return false;
    })().finally(() => {
      state.probePromise = null;
    });

    return state.probePromise;
  }

  function bootstrapServiceWorker() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return Promise.resolve(false);
    }

    if (navigator.onLine === false) {
      return Promise.resolve(false);
    }

    if (state.swBootstrapPromise) {
      return state.swBootstrapPromise;
    }

    state.swBootstrapPromise = import('/sw-register.js')
      .then(() => true)
      .catch((error) => {
        console.warn('[offline-shell] service worker bootstrap failed', error);
        state.swBootstrapPromise = null;
        return false;
      });

    return state.swBootstrapPromise;
  }

  async function ensureOnlineOrModal({
    appName = 'This demo',
    healthUrl = HEALTH_URL,
    body,
    detail,
  } = {}) {
    if (navigator.onLine === false) {
      showOfflineModal({
        body: body || `${appName} is offline right now.`,
        detail: detail || 'Reconnect to the internet and this page will reload automatically.',
      });
      return false;
    }

    const healthy = await probeHealth(healthUrl);
    if (healthy) {
      hideOfflineModal();
      return true;
    }

    showOfflineModal({
      body: body || `${appName} cannot reach BrowserBox right now.`,
      detail: detail || 'Waiting for the BrowserBox shell to respond before reloading.',
    });
    scheduleProbe('preflight');
    return false;
  }

  function noteNetworkFailure(error, {
    appName = 'This demo',
    body,
    detail,
  } = {}) {
    if (!isLikelyNetworkFailure(error)) {
      return false;
    }

    showOfflineModal({
      body: body || `${appName} lost its internet connection.`,
      detail: detail || 'Reconnect to the internet and this page will reload automatically.',
    });

    if (navigator.onLine !== false) {
      scheduleProbe('network-failure');
    }
    return true;
  }

  window.addEventListener('offline', () => {
    clearProbeTimer();
    showOfflineModal();
  });

  window.addEventListener('online', () => {
    void bootstrapServiceWorker();
    void runProbe('online-event');
  });

  if (navigator.onLine === false) {
    showOfflineModal();
  } else {
    void bootstrapServiceWorker();
  }

  globalThis.PerfectSaasOfflineShell = {
    bootstrapServiceWorker,
    ensureOnlineOrModal,
    hideOfflineModal,
    isLikelyNetworkFailure,
    noteNetworkFailure,
    probeHealth,
    requestReload,
    showOfflineModal,
  };
})();
