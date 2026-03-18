function shouldEnableBrowserBox() {
  const params = new URLSearchParams(window.location.search);
  return params.get('browserbox') === '1' || params.get('bbx') === '1';
}

function loadScript(src, { type = 'text/javascript' } = {}) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve(existing);
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.type = type;
    script.onload = () => resolve(script);
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function bootBrowserBoxIntegration() {
  if (typeof window === 'undefined' || !shouldEnableBrowserBox()) {
    return;
  }

  try {
    await Promise.allSettled([
      loadScript('/offline-shell.js'),
      loadScript('/browserbox-webview.js', { type: 'module' }),
    ]);

    if (!window.customElements?.get('browserbox-webview')) {
      console.warn('[debian-bbx] browserbox-webview is unavailable; skipping BrowserBox integration');
      return;
    }

    await import('./browserbox-integration.js');
  } catch (error) {
    console.error('[debian-bbx] failed to bootstrap BrowserBox integration', error);
  }
}

void bootBrowserBoxIntegration();
