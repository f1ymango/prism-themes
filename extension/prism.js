// Prism Themes content script (tier 2). Loaded by Claude Desktop from the React DevTools slot when REACT_PROFILE=1.
// It only applies data the mod wrote: prism-theme.json ({} for Claude's own look) and events/<session>.json.
// Attributes it owns on <html>: data-tfc-theme, data-tfc-mode, data-tfc-roles, data-tfc-missing, data-tfc-wall,
// data-tfc-bg, data-tfc-event, data-tfc-tool, data-tfc-state, data-tfc-panels; its own #prism-notice when something broke
// (prism-health.json); on the app's own elements, only its own markers
// data-tfc-panel and data-tfc-clear (never an attribute the app uses). It also sets data-mode to the theme's mode while a theme is on,
// and puts the app's own value back afterwards.
(() => {
  if (window.top !== window) return;

  /*@compile*/

  const root = document.documentElement;
  const url = path => chrome.runtime.getURL(path);
  const REQUIRED = ['sidebar', 'composer'];

  // A theme's CSS loads nothing from outside. Backslashes are refused because a CSS escape can spell url( past these.
  const safe = css => typeof css === 'string' && css.length <= 200000 && !/\\/.test(css)
    && !/@import|image-set|expression\s*\(|-moz-binding|behavior\s*:|javascript:/i.test(css)
    && !/url\(\s*(?!['"]?data:)/i.test(css);
  const okVar = (k, v) => /^[a-z][a-z0-9-]{0,80}$/.test(k) && typeof v === 'string' && v.length <= 500
    && !/[;{}<>]/.test(v) && safe(v);
  const okFile = f => typeof f === 'string' && /^prism-assets\/bg-[0-9a-f]{8}\.(jpg|png|gif|webp|avif|svg|mp4|webm)$/.test(f);
  const setAttr = (name, value) => {
    if (value === undefined || value === null || value === false) { if (root.hasAttribute(name)) root.removeAttribute(name); }
    else if (root.getAttribute(name) !== String(value)) root.setAttribute(name, String(value));
  };

  let theme = null;   // the payload in force, or null
  let lastText = '';
  let mode;
  let rolesKey = '';
  let bgReady = false;

  const styleEl = () => {
    let s = document.getElementById('prism-theme');
    if (!s) { s = document.createElement('style'); s.id = 'prism-theme'; }
    if (s.parentNode !== document.head || s !== document.head.lastElementChild) document.head.append(s); // after Claude's own
    return s;
  };

  // Light and dark parts of the app follow data-mode; a theme sets its own and restores the app's when it ends.
  const MODES = '[data-mode=light],[data-mode=dark],[data-mode=system]';
  const syncMode = () => {
    for (const el of document.querySelectorAll(MODES)) {
      if (mode && el.dataset.mode !== mode) {
        if (!el.hasAttribute('data-tfc-was-mode')) el.setAttribute('data-tfc-was-mode', el.dataset.mode);
        el.dataset.mode = mode;
      } else if (!mode && el.hasAttribute('data-tfc-was-mode')) {
        el.dataset.mode = el.getAttribute('data-tfc-was-mode');
        el.removeAttribute('data-tfc-was-mode');
      }
    }
  };

  // Side panels over a background: mark each panel, and the layers inside it that paint most of it a solid colour.
  // Judged by size and colour, never by class name; rows, buttons and hover states are small and keep theirs.
  const PANEL_ROLES = ['sidebar', 'sidePanel'];
  const opaque = el => {
    const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    return (parts.length > 3 ? parseFloat(parts[3]) : 1) > 0.5;
  };
  const clearPanels = () => {
    for (const el of document.querySelectorAll('[data-tfc-panel],[data-tfc-clear]')) {
      el.removeAttribute('data-tfc-panel');
      el.removeAttribute('data-tfc-clear');
    }
  };
  let lastResolved = {}, glassTimer = 0;
  // Marks the layers inside a panel that paint most of it; returns how many it holds (marked before or now).
  const clearInside = panel => {
    const box = panel.getBoundingClientRect();
    const area = box.width * box.height;
    if (!area) return 0;
    let count = 0;
    let level = [...panel.children];
    for (let depth = 0; depth < 6 && level.length; depth++) {
      const next = [];
      for (const el of level) {
        const r = el.getBoundingClientRect();
        if (r.width * r.height < area * 0.6) continue;
        if (el.hasAttribute('data-tfc-clear')) count++;
        else if (opaque(el)) { el.setAttribute('data-tfc-clear', ''); count++; }
        next.push(...el.children);
      }
      level = next;
    }
    return count;
  };
  // Panes beside the chat (details, terminal, browser...): the large neighbours met on the way up from the
  // composer. Found by layout, not by class, since their markup differs between app versions.
  const paneCandidates = () => {
    const composer = lastResolved.composer && document.querySelector(lastResolved.composer);
    const out = new Set();
    for (let el = composer; el && el.parentElement && el !== document.body; el = el.parentElement) {
      for (const sib of el.parentElement.children) {
        if (sib === el || sib.contains(composer)) continue;
        const r = sib.getBoundingClientRect();
        if (r.width >= 160 && r.height >= innerHeight * 0.3) out.add(sib);
      }
    }
    return [...out];
  };
  const glassify = () => {
    glassTimer = 0;
    const want = !!theme && root.hasAttribute('data-tfc-wall') && ['glass', 'clear'].includes(theme.panels);
    setAttr('data-tfc-panels', want ? theme.panels : undefined);
    if (!want) { clearPanels(); return; }
    const panels = new Map();
    for (const role of PANEL_ROLES) {
      const el = lastResolved[role] && document.querySelector(lastResolved[role]);
      if (el) panels.set(el, role);
    }
    const big = el => {
      const r = el.getBoundingClientRect();
      return r.width >= 160 && r.width < innerWidth * 0.9 && r.height >= innerHeight * 0.3;
    };
    // A pane counts only when it really paints a solid surface (never glass over an invisible overlay); a wrapper
    // that paints nothing itself is searched for the panes inside it.
    const visit = (el, depth) => {
      if ([...panels.keys()].some(p => p === el || p.contains(el) || el.contains(p))) return;
      const narrow = el.getBoundingClientRect().width < innerWidth * 0.9; // a full-window layer is never a pane
      if (narrow && (el.hasAttribute('data-tfc-panel') || opaque(el) || clearInside(el))) { panels.set(el, 'pane'); return; }
      if (depth < 3) for (const child of el.children) if (big(child)) visit(child, depth + 1);
    };
    for (const el of paneCandidates()) visit(el, 0);
    for (const [panel, role] of panels) {
      clearInside(panel);
      if (panel.getAttribute('data-tfc-panel') !== role) panel.setAttribute('data-tfc-panel', role);
    }
  };
  const scheduleGlass = () => { if (!glassTimer) glassTimer = setTimeout(glassify, 300); };

  const appMode = () => {
    const m = root.getAttribute('data-tfc-was-mode') || root.dataset.mode;
    if (m === 'light' || m === 'dark') return m;
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  };

  // C4: resolve roles against the page now; rebuild the stylesheet only when that changes.
  const paint = force => {
    if (!theme) return;
    const resolved = resolveRoles(theme.roles || {}, s => !!document.querySelector(s));
    lastResolved = resolved;
    // a theme with light and dark variants follows the app's own mode (it never forces one)
    const variant = theme.variants ? appMode() : '';
    if (theme.variants) setAttr('data-tfc-mode', variant);
    const key = resolvedKey(resolved) + (bgReady ? '|bg' : '') + '|' + variant;
    setAttr('data-tfc-wall', wallReady(resolved) && (!theme.background || bgReady) ? '' : undefined);
    scheduleGlass();
    if (!force && key === rolesKey) return;
    rolesKey = key;
    const found = Object.keys(resolved).filter(k => resolved[k]);
    setAttr('data-tfc-roles', found.join(' '));
    setAttr('data-tfc-missing', REQUIRED.filter(k => !resolved[k]).join(' ') || undefined);
    const { css: ruleCss, dropped } = compileRules(theme.rules || [], resolved);
    const vars = { ...(theme.vars || {}), ...((theme.variants && theme.variants[variant]) || {}) };
    const decl = Object.entries(vars).filter(([k, v]) => okVar(k, v) || (console.warn('prism-themes: var refused', k), false))
      .map(([k, v]) => `--${k}: ${v} !important;`).join(' ');
    const extra = [theme.css || '', ruleCss].join('\n');
    const css = safe(extra) ? extra : (console.warn('prism-themes: stylesheet refused'), '');
    styleEl().textContent = `:root, :root * { ${decl} }\n${css}`;
    if (dropped.length) console.info('prism-themes: rules off until their roles appear:', dropped.join(', '));
  };

  // C3: a media background on a layer behind the page. Never through CSS url(): the filter above stays strict.
  let layer = null, layerKey = '', slideTimer = 0;
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const load = (el, file, kind) => new Promise(resolve => {
    // the page's own policy may refuse an extension URL; then try the same bytes as a blob
    const ok = how => { el.onload = el.onloadeddata = el.onerror = null; resolve(how); };
    el.onerror = async () => {
      try {
        const blob = await fetch(url(file)).then(r => r.blob());
        el.onerror = () => ok('failed');
        el[kind === 'video' ? 'onloadeddata' : 'onload'] = () => ok('blob');
        el.src = URL.createObjectURL(blob);
      } catch { ok('failed'); }
    };
    el[kind === 'video' ? 'onloadeddata' : 'onload'] = () => ok('extension');
    el.src = url(file);
  });
  const media = (bg, kind) => {
    const el = document.createElement(kind === 'video' ? 'video' : 'img');
    el.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:${bg.fit === 'contain' ? 'contain' : 'cover'};transition:opacity 1.2s`;
    if (kind === 'video') Object.assign(el, { muted: true, loop: true, playsInline: true, autoplay: !calm(), preload: 'auto' });
    else el.decoding = 'async';
    el.setAttribute('aria-hidden', 'true');
    return el;
  };
  const clearLayer = () => {
    clearInterval(slideTimer);
    layer?.querySelectorAll('img,video').forEach(el => { if (el.src.startsWith('blob:')) URL.revokeObjectURL(el.src); });
    layer?.remove();
    layer = null;
    bgReady = false;
    setAttr('data-tfc-bg', undefined);
  };
  const showBackground = async bg => {
    const key = JSON.stringify(bg || null);
    if (key === layerKey) return;
    layerKey = key;
    clearLayer();
    const files = (bg?.files || []).filter(okFile);
    if (!bg || !files.length) return;
    const own = document.createElement('div');
    own.id = 'prism-wall-layer';
    own.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden';
    const dim = document.createElement('div');
    dim.style.cssText = 'position:absolute;inset:0;background:var(--prism-dim, transparent)';
    layer = own;
    const kind = bg.provider === 'video' ? 'video' : 'img';
    const first = media(bg, kind);
    own.append(first, dim);
    document.body.prepend(own);
    setAttr('data-tfc-bg', 'loading');
    const how = await load(first, files[0], kind);
    if (layer !== own) return; // replaced meanwhile
    setAttr('data-tfc-bg', `${bg.provider}:${how}`);
    bgReady = how !== 'failed';
    if (kind === 'video' && bgReady && !calm()) first.play().catch(() => {});
    if (bg.provider === 'slideshow' && bgReady && files.length > 1 && !calm()) {
      let i = 0;
      slideTimer = setInterval(async () => {
        if (document.hidden || layer !== own) return;
        i = (i + 1) % files.length;
        const next = media(bg, 'img');
        next.style.opacity = '0';
        own.insertBefore(next, dim);
        if ((await load(next, files[i], 'img')) === 'failed') { next.remove(); return; }
        requestAnimationFrame(() => { next.style.opacity = '1'; });
        setTimeout(() => { const old = own.querySelectorAll('img'); for (let k = 0; k < old.length - 1; k++) old[k].remove(); }, 1400);
      }, Math.max(5, bg.interval || 60) * 1000);
    }
    paint(true);
  };
  document.addEventListener('visibilitychange', () => {
    const v = layer?.querySelector('video');
    if (v) document.hidden || calm() ? v.pause() : v.play().catch(() => {});
  });

  const apply = text => {
    let p;
    try { p = JSON.parse(text || '{}'); } catch { console.warn('prism-themes: prism-theme.json is not JSON'); return; }
    if (!p || p.v !== 1 || typeof p.id !== 'string') {
      theme = null;
      document.getElementById('prism-theme')?.remove();
      for (const a of ['data-tfc-theme', 'data-tfc-mode', 'data-tfc-wall', 'data-tfc-roles', 'data-tfc-missing', 'data-tfc-panels']) setAttr(a, undefined);
      clearPanels();
      showBackground(null);
      mode = undefined;
      syncMode();
      return;
    }
    theme = p;
    setAttr('data-tfc-theme', p.id);
    mode = p.mode === 'light' || p.mode === 'dark' ? p.mode : undefined;
    setAttr('data-tfc-mode', mode);
    syncMode();
    paint(true);
    showBackground(p.background);
  };

  const tickTheme = async () => {
    if (document.hidden) return;
    try {
      const text = await fetch(url('prism-theme.json'), { cache: 'no-store' }).then(r => r.text());
      if (text !== lastText) { lastText = text; apply(text); }
    } catch (err) {
      console.warn('prism-themes: cannot read prism-theme.json', err);
    }
  };

  // C5: this window's session is in its address (/epitaxy/<local id>); its events are in events/<id>.json.
  let lastN = 0, eventTimer = 0;
  const tickEvent = async () => {
    if (document.hidden || !theme) return;
    const id = location.pathname.match(/\/epitaxy\/(local_[\w-]+)/)?.[1];
    if (!id) { setAttr('data-tfc-state', undefined); return; }
    try {
      const ev = await fetch(url(`events/${id}.json`), { cache: 'no-store' }).then(r => (r.ok ? r.json() : null));
      if (!ev || typeof ev.state !== 'string') return;
      // "waiting" may be answered at once by auto mode's classifier: show it only once it has lasted 1.5 s
      const waited = ev.state === 'waiting' && Date.now() - (ev.stateAt || 0) > 1500;
      setAttr('data-tfc-state', waited ? 'waiting' : ev.state === 'thinking' || ev.state === 'waiting' ? 'thinking' : undefined);
      const p = ev.pulse;
      if (!p) { if (lastN === 0) lastN = -1; return; } // read once with no pulse yet: the next one is fresh
      if (typeof p.n !== 'number' || p.n === lastN) return;
      const fresh = lastN !== 0 && Date.now() - p.at < 5000;
      lastN = p.n;
      if (!fresh || !['tool', 'error', 'done'].includes(p.kind)) return;
      setAttr('data-tfc-event', p.kind);
      setAttr('data-tfc-tool', typeof p.tool === 'string' && /^[\w-]{1,80}$/.test(p.tool) ? p.tool : undefined);
      clearTimeout(eventTimer);
      eventTimer = setTimeout(() => { setAttr('data-tfc-event', undefined); setAttr('data-tfc-tool', undefined); }, 1200);
    } catch { /* no events yet for this session */ }
  };

  // Breakage notice. An update can break Prism while the last theme stays on screen, so nothing looks wrong until a
  // change fails. Two sources: prism-health.json, which the mod writes when a part of it fails, and this page's own
  // check that the prompt box is still found. Dismissed per message, for this window's lifetime.
  let healthProblems = [], composerLostAt = 0, noticeKey = '', dismissed = '';
  const noticeText = () => {
    if (healthProblems.length) {
      return `Prism stopped working after an update: ${healthProblems.join(', ')}. The theme on screen may stay, ` +
        'but changes won\'t apply. Run /prism doctor in Claude Code.';
    }
    if (composerLostAt && Date.now() - composerLostAt > 10000) {
      return 'Prism can\'t find Claude\'s prompt box. Claude Desktop probably changed its layout, so parts of the theme ' +
        'may be missing. Run /prism doctor, and check for a newer Prism.';
    }
    return '';
  };
  const showNotice = () => {
    const text = noticeText();
    const key = text && text.slice(0, 120);
    let el = document.getElementById('prism-notice');
    if (!text || key === dismissed) { el?.remove(); noticeKey = ''; return; }
    if (el && key === noticeKey) return;
    noticeKey = key;
    el?.remove();
    el = document.createElement('div');
    el.id = 'prism-notice';
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:2147483646;' +
      'max-width:min(560px,calc(100vw - 32px));display:flex;gap:10px;align-items:flex-start;padding:9px 12px;' +
      'border-radius:8px;border:1px solid #e5484d;background:rgba(24,24,27,.94);color:#f4f4f5;' +
      'font:12px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);text-shadow:none';
    const msg = document.createElement('span');
    msg.textContent = text;
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.style.cssText = 'all:unset;cursor:pointer;font-size:15px;line-height:1;padding:0 2px;color:#a1a1aa';
    close.onclick = () => { dismissed = key; showNotice(); };
    el.append(msg, close);
    document.body.append(el);
  };
  const tickHealth = async () => {
    if (document.hidden) return;
    try {
      const h = await fetch(url('prism-health.json'), { cache: 'no-store' }).then(r => (r.ok ? r.json() : null));
      healthProblems = h && h.v === 1 && Array.isArray(h.problems)
        ? h.problems.map(p => (p && typeof p.name === 'string' ? p.name.slice(0, 80) : '')).filter(Boolean).slice(0, 6)
        : [];
    } catch { healthProblems = []; } // no file: nothing reported
    // only on a conversation page, where the prompt box always is, and only while a theme is on
    const onChat = /\/epitaxy\/local_/.test(location.pathname);
    const lost = !!theme && onChat && !!theme.roles?.composer && !lastResolved.composer;
    composerLostAt = lost ? composerLostAt || Date.now() : 0;
    showNotice();
  };

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; paint(false); if (mode) syncMode(); });
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-mode'] });

  tickTheme();
  setInterval(tickTheme, 1000);
  setInterval(tickEvent, 400);
  setInterval(tickHealth, 3000);
})();
