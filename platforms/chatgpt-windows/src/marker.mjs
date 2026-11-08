// This function is serialized into a dedicated isolated world in the app renderer.
// It consumes no conversation data, attaches no input handlers, and expires itself.
export function markerRuntime(action, { runId, ttlMs = 120_000 } = {}) {
  const key = '__prismLoaderProbeV1';
  const id = 'prism-loader-probe-v1';
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(runId ?? '')) throw new Error('Invalid probe run ID');
  if (!Number.isInteger(ttlMs) || ttlMs < 100 || ttlMs > 120_000) throw new Error('Invalid marker lifetime');
  if (!['apply', 'status', 'remove'].includes(action)) throw new Error('Unknown marker action');
  if (globalThis.top !== globalThis) throw new Error('Only the top-level app frame may be modified');
  const state = globalThis[key];
  const existing = document.getElementById(id);
  if ((state && state.runId !== runId) || (existing && (existing !== state?.element || existing.getAttribute('data-prism-run') !== runId))) {
    throw new Error('A different owner already uses the probe marker');
  }
  const status = current => {
    const element = current?.element;
    const rect = element?.getBoundingClientRect();
    return {
      installed: !!element?.isConnected,
      count: document.querySelectorAll(`#${id}`).length,
      pointerEvents: element ? getComputedStyle(element).pointerEvents : null,
      ariaHidden: element?.getAttribute('aria-hidden') ?? null,
      visible: !!rect && rect.width > 0 && rect.height > 0 && getComputedStyle(element).display !== 'none',
      markerText: element?.shadowRoot?.textContent?.trim() ?? null,
    };
  };
  if (action === 'status') return status(state);
  if (action === 'remove') {
    if (state) {
      clearTimeout(state.timer);
      state.element.remove();
      delete globalThis[key];
    }
    return status(null);
  }
  if (state) return status(state);
  if (!document.body) throw new Error('App document is not ready');
  const element = document.createElement('div');
  element.id = id;
  element.setAttribute('data-prism-run', runId);
  element.setAttribute('aria-hidden', 'true');
  element.style.cssText = 'all:initial;position:fixed;top:14px;right:18px;z-index:2147483646;pointer-events:none;display:block;contain:content';
  const shadow = element.attachShadow({ mode: 'open' });
  const badge = document.createElement('span');
  badge.style.cssText = 'display:block;padding:9px 13px;border:1px solid #65e6b5;border-radius:8px;background:#10251f;color:#baffdf;font:600 13px system-ui,sans-serif;box-shadow:0 2px 12px #0006;white-space:nowrap';
  badge.textContent = 'Prism loader probe';
  shadow.append(badge);
  const current = { runId, element, timer: null };
  Object.defineProperty(globalThis, key, { value: current, configurable: true });
  current.timer = setTimeout(() => {
    if (globalThis[key] === current) {
      element.remove();
      delete globalThis[key];
    }
  }, ttlMs);
  document.documentElement.append(element);
  return status(current);
}

export const markerExpression = (action, options) => `(${markerRuntime.toString()})(${JSON.stringify(action)},${JSON.stringify(options)})`;
