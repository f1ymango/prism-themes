import { normalizeSettings } from './settings.mjs';
import { parsePrismCommand } from './prism-command.mjs';
import { browserImageInfo } from './browser-image-info.mjs';
import { wallpaperStyle } from './wallpaper-style.mjs';

// Serialized into the app's isolated world. Shared DOM changes are restricted to owned
// elements/attributes and reviewed surfaces under #root. Shared styles are removed
// with the owned stylesheet, restoring native backgrounds without inline edits.
export async function wallpaperRuntime(action, options, validateSettings, parseCommand, inspectImage, makeStyle) {
  const key = '__prismWallpaperV1', loadingKey = '__prismWallpaperLoadingV1', transferKey = '__prismWallpaperTransferV1';
  const layerId = 'prism-wallpaper-v1', styleId = 'prism-wallpaper-style-v1', controlsId = 'prism-wallpaper-controls-v1';
  const attribute = 'data-prism-wallpaper', surfaceAttribute = 'data-prism-wallpaper-surface';
  const { runId, ttlMs = 120_000 } = options ?? {};
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(runId ?? '')) throw new Error('Invalid wallpaper owner.');
  if (!['apply', 'update', 'status', 'remove', 'renew', 'transfer-start', 'transfer-chunk', 'transfer-abort'].includes(action)) throw new Error('Unknown wallpaper action.');
  if (!Number.isInteger(ttlMs) || ttlMs < 100 || ttlMs > 120_000) throw new Error('Invalid wallpaper lifetime.');
  if (globalThis.top !== globalThis || location.protocol !== 'app:') throw new Error('Only the top-level app renderer is supported.');
  const current = globalThis[key], loading = globalThis[loadingKey], transfer = globalThis[transferKey];
  if ((current && current.runId !== runId) || (loading && loading.runId !== runId) || (transfer && transfer.runId !== runId)) throw new Error('Wallpaper belongs to a different owner.');
  for (const [id, owned] of [[layerId, current?.layer], [styleId, current?.style], [controlsId, current?.controls]]) {
    const found = document.getElementById(id);
    if (found && found !== owned) throw new Error('A wallpaper element belongs to a different owner.');
  }
  if (document.documentElement.hasAttribute(attribute) && document.documentElement.getAttribute(attribute) !== runId) throw new Error('Wallpaper root attribute belongs to a different owner.');

  const status = state => ({
    installed: !!state?.layer.isConnected,
    count: document.querySelectorAll(`#${layerId}`).length,
    controlsCount: document.querySelectorAll(`#${controlsId}`).length,
    activeObjectUrls: state?.objectUrl ? 1 : 0,
    transferBytes: globalThis[transferKey]?.received ?? 0,
    settings: state ? { ...state.settings } : null,
    image: state ? { name: state.image.name, mime: state.image.mime, kind: state.img.tagName === 'VIDEO' ? 'video' : 'image', width: state.img.videoWidth || state.img.naturalWidth, height: state.img.videoHeight || state.img.naturalHeight, sha256: state.image.sha256 } : null,
    playback: state?.img.tagName === 'VIDEO' ? { paused: state.img.paused, currentTime: state.img.currentTime, muted: state.img.muted, loop: state.img.loop, pauseReason: state.pauseReason ?? null } : null,
    pointerEvents: state ? getComputedStyle(state.layer).pointerEvents : null,
    ariaHidden: state?.layer.getAttribute('aria-hidden') ?? null,
    surfaceCount: state?.surfaces.size ?? 0,
    ownedSurfaceAttributes: document.querySelectorAll(`[${surfaceAttribute}="${runId}"]`).length,
    rootAttributePresent: document.documentElement.getAttribute(attribute) === runId,
    stylePresent: !!document.getElementById(styleId),
    shade: state?.shade ?? null,
    controllerError: state?.controllerError ?? null,
    panelOpen: state?.panelOpen ?? false,
    pickerBusy: state?.pickerBusy ?? false,
    visible: !!state && state.layer.getBoundingClientRect().width > 0 && (state.img.tagName === 'VIDEO' ? state.img.readyState >= 2 && state.img.videoWidth > 0 : state.img.complete && state.img.naturalWidth > 0),
  });

  const discardTransfer = pending => {
    if (!pending) return;
    clearTimeout(pending.timer); pending.parts.length = 0;
    if (globalThis[transferKey] === pending) delete globalThis[transferKey];
  };
  const renewTransfer = pending => { clearTimeout(pending.timer); pending.timer = setTimeout(() => discardTransfer(pending), 20000); };
  if (action === 'transfer-start') {
    const image = options.image;
    if (loading) throw new Error('Wallpaper is already loading.');
    if (!image || !['video/mp4','video/webm'].includes(image.mime) || !Number.isSafeInteger(image.bytes) || image.bytes < 1 || image.bytes > 128 * 1024 * 1024 || !/^[a-f0-9]{64}$/i.test(image.sha256 ?? '') || typeof image.name !== 'string' || image.name.length > 255) throw new Error('Invalid video transfer metadata.');
    discardTransfer(transfer);
    const pending = { runId, id: crypto.randomUUID(), image: { name: image.name, mime: image.mime, sha256: image.sha256, bytes: image.bytes }, parts: [], received: 0, index: 0, timer: null };
    Object.defineProperty(globalThis, transferKey, { value: pending, configurable: true });
    renewTransfer(pending);
    return { transferId: pending.id };
  }
  if (action === 'transfer-chunk' || action === 'transfer-abort') {
    if (!transfer || options.transferId !== transfer.id) throw new Error('Video transfer is no longer available.');
    if (action === 'transfer-abort') { discardTransfer(transfer); return { aborted: true }; }
    if (options.index !== transfer.index || typeof options.dataBase64 !== 'string' || options.dataBase64.length > 699052 || !/^[A-Za-z0-9+/]+={0,2}$/.test(options.dataBase64)) throw new Error('Invalid or out-of-order video chunk.');
    const bytes = Uint8Array.from(atob(options.dataBase64), character => character.charCodeAt(0));
    if (!bytes.length || bytes.length > 512 * 1024 || transfer.received + bytes.length > transfer.image.bytes) throw new Error('Video transfer exceeds its declared size.');
    transfer.parts.push(bytes); transfer.received += bytes.length; transfer.index++;
    renewTransfer(transfer);
    return { received: transfer.received };
  }

  const releaseMedia = media => {
    if (media?.tagName === 'VIDEO') { media.pause(); media.removeAttribute('src'); media.load(); }
    media?.remove();
  };
  const syncPlayback = state => {
    if (state.img.tagName !== 'VIDEO') { state.pauseReason = null; return; }
    state.pauseReason = document.hidden ? 'hidden' : state.motion.matches ? 'reduced-motion' : null;
    if (state.pauseReason) state.img.pause();
    else if (state.img.paused) state.img.play().catch(error => { if (globalThis[key] === state) state.controllerError = `Video playback failed: ${error.message}`; });
  };

  const dispose = state => {
    if (globalThis[loadingKey]?.runId === runId) globalThis[loadingKey].cancelled = true;
    discardTransfer(globalThis[transferKey]);
    if (!state) return;
    clearTimeout(state.timer); clearTimeout(state.refreshTimer);
    state.observer?.disconnect();
    removeEventListener('resize', state.onResize);
    if (state.onKeyDown) removeEventListener('keydown', state.onKeyDown, true);
    state.removalObserver?.disconnect();
    clearTimeout(state.saveTimer);
    document.removeEventListener('visibilitychange', state.onPlaybackChange);
    state.motion?.removeEventListener('change', state.onPlaybackChange);
    for (const element of state.surfaces) {
      if (element.getAttribute(surfaceAttribute) === runId) element.removeAttribute(surfaceAttribute);
    }
    if (document.documentElement.getAttribute(attribute) === runId) document.documentElement.removeAttribute(attribute);
    releaseMedia(state.img);
    state.layer.remove(); state.style.remove(); state.controls?.remove();
    if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
    if (globalThis[key] === state) delete globalThis[key];
  };
  if (action === 'status') return status(current);
  if (action === 'remove') { dispose(current); return status(null); }
  if (current && ['apply','update','renew'].includes(action)) {
    const css = makeStyle(runId);
    if (current.style.textContent !== css) current.style.textContent = css;
  }
  if (action === 'renew') {
    if (current) { clearTimeout(current.timer); current.timer = setTimeout(() => dispose(current), ttlMs); syncPlayback(current); }
    return status(current);
  }
  if (action === 'update' && !current) throw new Error('Apply an image before updating its settings.');
  let settings = validateSettings(action === 'update' ? { ...current.settings, ...options.settings } : options.settings);
  const storage = async (method, value) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('prism-wallpaper-v1', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('preferences'); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction('preferences', method === 'get' ? 'readonly' : 'readwrite');
        const store = transaction.objectStore('preferences');
        const request = method === 'get' ? store.get('selection') : store.put(value, 'selection');
        let result;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => resolve(method === 'get' ? result : value);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('Saving was cancelled.'));
      });
    } finally { database.close(); }
  };

  const refreshSurfaces = state => {
    const root = document.getElementById('root');
    if (!root) throw new Error('The reviewed app root was not found.');
    const found = new Set();
    const candidates = [...root.querySelectorAll('.bg-surface, main')].slice(0, 1000);
    for (const element of candidates) {
      if (element.closest('[role="dialog"],[aria-modal="true"]')) continue;
      const rect = element.getBoundingClientRect();
      const mainSurface = element.tagName === 'MAIN' && [...element.classList].some(name => name.startsWith('MainContentSurface-'));
      if (mainSurface ? (rect.width < innerWidth * .3 || rect.height < innerHeight * .5) : (rect.width < innerWidth * .85 || rect.height < innerHeight * .85)) continue;
      if (element.hasAttribute(surfaceAttribute) && element.getAttribute(surfaceAttribute) !== runId) continue;
      found.add(element);
    }
    for (const element of state.surfaces) if (!found.has(element) && element.getAttribute(surfaceAttribute) === runId) element.removeAttribute(surfaceAttribute);
    for (const element of found) element.setAttribute(surfaceAttribute, runId);
    state.surfaces = found;
    // Match the native foreground: dark text receives a light wash, light text a dark wash.
    const foreground = getComputedStyle(found.values().next().value ?? root).color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    state.shade = foreground?.length === 3 && foreground.reduce((a, b) => a + b, 0) < 384 ? '#f8f8f8' : '#181818';
    state.layer.style.backgroundColor = state.shade;
    state.veil.style.backgroundColor = state.shade;
  };

  const refreshControls = state => {
    if (!state.controls) return;
    const shadow = state.controls.shadowRoot;
    shadow.querySelector('[name="dim"]').value = String(Math.round(state.settings.dim * 100));
    shadow.querySelector('output').textContent = `${Math.round(state.settings.dim * 100)}%`;
    shadow.querySelector('[name="fit"]').value = state.settings.fit;
    shadow.querySelector('[name="position"]').value = state.settings.position;
    shadow.querySelector('.filename').textContent = state.image.name;
    shadow.querySelector('.note').textContent = state.mode === 'session' ? 'Changes are saved automatically' : 'Isolated preview · temporary settings';
  };
  const makeControls = state => {
    const element = document.createElement('section');
    element.id = controlsId;
    element.setAttribute('aria-label', 'Wallpaper preview controls');
    element.style.cssText = 'all:initial;font:13px system-ui,sans-serif;color:#e9eeff;position:fixed;right:18px;bottom:18px;z-index:2147483000;display:block;max-width:calc(100vw - 36px);color-scheme:dark';
    const shadow = element.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{font:13px system-ui,sans-serif;color:#e9eeff}*{box-sizing:border-box}
      .panel{width:268px;padding:16px;border:1px solid #ffffff26;border-radius:16px;background:#101626eb;box-shadow:0 12px 40px #0006;backdrop-filter:blur(14px)}
      h2{font-size:14px;margin:0 0 4px;letter-spacing:.01em}.note{font-size:11px;color:#a6b2ca;margin:0 0 12px}
      .filename{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:12px;color:#b7d9d6}
      label{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px}input{width:155px;accent-color:#92d9c6}
      select,button{font:inherit;color:inherit;border:1px solid #ffffff2b;border-radius:7px;background:#222d43;padding:5px 8px}select{width:130px}
      button{width:100%;margin-top:14px;cursor:pointer}button:hover{background:#31435f}input:focus-visible,select:focus-visible,button:focus-visible{outline:2px solid #92d9c6;outline-offset:3px}
      .dim{display:flex;gap:6px;align-items:center}output{font-variant-numeric:tabular-nums;min-width:30px;text-align:right}
    </style><div class="panel"><h2>Wallpaper</h2><p class="note">Isolated preview · temporary settings</p><div class="filename"></div>
      <label>Dim <span class="dim"><input name="dim" aria-label="Wallpaper dimming" type="range" min="0" max="100" step="1"><output></output></span></label>
      <label>Fit <select name="fit"><option value="cover">Fill window</option><option value="contain">Fit image</option></select></label>
      <label>Position <select name="position"><option value="center">Center</option><option value="top">Top</option><option value="bottom">Bottom</option><option value="left">Left</option><option value="right">Right</option></select></label>
      <button type="button">Restore appearance</button></div>`;
    const change = () => {
      try {
        state.settings = validateSettings({ ...state.settings, dim: Number(shadow.querySelector('[name="dim"]').value) / 100, fit: shadow.querySelector('[name="fit"]').value, position: shadow.querySelector('[name="position"]').value });
        paint(state);
        state.persistSettings?.();
      } catch (error) { state.controllerError = error.message; }
    };
    shadow.querySelector('input[type="range"]').addEventListener('input', change);
    for (const select of shadow.querySelectorAll('select')) select.addEventListener('change', change);
    shadow.querySelector('button').dataset.command = 'restore';
    shadow.querySelector('[data-command="restore"]').addEventListener('click', () => {
      if (state.mode === 'session') state.hostCommand = 'restore';
      else dispose(state);
    });
    if (state.mode === 'session') {
      const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close Prism window';
      close.dataset.command = 'close';
      close.style.marginTop = '7px'; close.addEventListener('click', () => { state.hostCommand = 'close'; });
      shadow.querySelector('.panel').append(close);
    }
    const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/png,image/jpeg,image/webp'; picker.hidden = true; picker.name = 'wallpaper-file';
    const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = 'Choose image…'; choose.dataset.command = 'choose';
    const message = document.createElement('p'); message.className = 'note'; message.setAttribute('role', 'status'); message.style.marginTop = '10px';
    const command = document.createElement('input'); command.type = 'text'; command.name = 'prism-command'; command.placeholder = 'dim 40 · fit contain · choose'; command.setAttribute('aria-label', 'Prism command');
    command.style.cssText = 'box-sizing:border-box;width:100%;margin-top:12px;padding:8px;border:1px solid #ffffff2b;border-radius:7px;background:#172136;color:#e9eeff;font:12px system-ui';
    shadow.querySelector('.filename').after(choose, picker);
    shadow.querySelector('.panel').append(command, message);
    const tell = text => { message.textContent = text; };
    const persist = async image => {
      try {
        const saved = image ? { image, settings: state.settings } : await storage('get');
        if (saved?.image) await storage('put', { image: saved.image, settings: state.settings });
        return true;
      } catch { tell('Applied for this session; saving the image failed.'); return false; }
    };
    state.persistSettings = () => { clearTimeout(state.saveTimer); state.saveTimer = setTimeout(() => { persist().catch(() => {}); }, 250); };
    choose.addEventListener('click', () => picker.click());
    picker.addEventListener('change', async () => {
      const file = picker.files?.[0]; if (!file || state.pickerBusy) return;
      state.pickerBusy = true; choose.disabled = true; tell('Loading image…');
      try {
        if (file.size > 15 * 1024 * 1024) throw new Error('Choose an image no larger than 15 MiB.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const info = inspectImage(bytes);
        let binary = ''; for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const image = { ...info, name: file.name, dataBase64: btoa(binary), sha256: [...digest].map(value => value.toString(16).padStart(2,'0')).join('') };
        await wallpaperRuntime('apply', { runId, image, settings: state.settings, mode: state.mode }, validateSettings, parseCommand, inspectImage, makeStyle);
        if (await persist(image)) tell('Wallpaper saved.');
      } catch (error) { state.controllerError = error.message; tell(error.message); }
      finally { state.pickerBusy = false; choose.disabled = false; picker.value = ''; }
    });
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'toggle'; toggle.textContent = 'Wallpaper'; toggle.title = 'Wallpaper settings (Ctrl+Alt+P)';
    toggle.style.cssText = 'width:auto;float:right;margin-top:8px;padding:7px 12px;border-radius:20px;background:#172136ef';
    const panel = shadow.querySelector('.panel');
    state.setPanelOpen = (open, focus = false) => { state.panelOpen = open; panel.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); if (open && focus) command.focus(); };
    toggle.addEventListener('click', () => state.setPanelOpen(!state.panelOpen));
    shadow.append(toggle);
    state.setPanelOpen(options.panelOpen === true);
    state.onKeyDown = event => {
      if (!state.layer.isConnected) { removeEventListener('keydown', state.onKeyDown, true); return; }
      if (event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey && !event.isComposing && event.key.toLowerCase() === 'p') {
        event.preventDefault(); event.stopPropagation(); state.setPanelOpen(!state.panelOpen, true);
      }
    };
    addEventListener('keydown', state.onKeyDown, true);
    state.removalObserver = new MutationObserver(() => {
      if (!state.layer.isConnected) { removeEventListener('keydown', state.onKeyDown, true); state.removalObserver.disconnect(); }
    });
    state.removalObserver.observe(document.documentElement, { childList: true });
    command.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault(); event.stopPropagation();
      try {
        const parsed = parseCommand(command.value);
        if (parsed.action === 'choose') picker.click();
        else if (parsed.action === 'reset') shadow.querySelector('[data-command="restore"]').click();
        else if (parsed.action === 'hide' || parsed.action === 'show') state.setPanelOpen(parsed.action === 'show');
        else { state.settings = validateSettings({ ...state.settings, ...parsed.settings }); paint(state); state.persistSettings(); tell('Settings saved.'); }
        command.value = '';
      } catch (error) { tell(error.message); }
    });
    return element;
  };
  const paint = state => {
    state.img.style.objectFit = state.settings.fit;
    state.img.style.objectPosition = state.settings.position;
    state.veil.style.opacity = String(state.settings.dim);
    if (state.settings.controls && !state.controls) { state.controls = makeControls(state); document.documentElement.append(state.controls); }
    if (!state.settings.controls && state.controls) { state.controls.remove(); state.controls = null; }
    refreshControls(state);
  };

  if (action === 'update') { current.settings = settings; paint(current); return status(current); }
  if (loading) throw new Error('An image is already loading.');
  let image = options.image;
  let prepared;
  if (image?.transferId) {
    if (!transfer || image.transferId !== transfer.id || transfer.received !== transfer.image.bytes) throw new Error('Video transfer is incomplete or unavailable.');
    prepared = transfer; image = transfer.image;
  }
  if (!current && options.restoreSaved) {
    try {
      const saved = await storage('get');
      if (saved?.image) { image = saved.image; settings = validateSettings(saved.settings); }
    } catch { /* A blocked cache does not prevent displaying the configured image. */ }
  }
  const video = image?.mime === 'video/mp4' || image?.mime === 'video/webm';
  if (!image || !['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'].includes(image.mime) || typeof image.name !== 'string' || image.name.length > 255 || (!prepared && (typeof image.dataBase64 !== 'string' || image.dataBase64.length > (video ? 40 : 20) * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64)))) throw new Error('Invalid wallpaper media payload.');
  const operation = { runId, cancelled: false };
  Object.defineProperty(globalThis, loadingKey, { value: operation, configurable: true });
  let objectUrl, img, committed = false;
  try {
    if (prepared) {
      objectUrl = URL.createObjectURL(new Blob(prepared.parts, { type: image.mime }));
      discardTransfer(prepared);
    } else {
      const bytes = Uint8Array.from(atob(image.dataBase64), character => character.charCodeAt(0));
      if (bytes.length > (video ? 30 : 15) * 1024 * 1024) throw new Error('Wallpaper media exceeds the inline file-size limit.');
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: image.mime }));
    }
    img = document.createElement(video ? 'video' : 'img');
    if (video) { img.muted = true; img.defaultMuted = true; img.loop = true; img.playsInline = true; img.preload = 'auto'; img.disablePictureInPicture = true; }
    else { img.alt = ''; img.decoding = 'async'; }
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
    let decodeTimer, loaded, failed;
    try {
      const ready = video ? new Promise((resolve, reject) => {
        loaded = resolve; failed = () => reject(new Error('This video cannot be decoded. Try H.264 MP4 or VP8/VP9 WebM.'));
        img.addEventListener('loadeddata', loaded, { once: true }); img.addEventListener('error', failed, { once: true });
      }) : null;
      // Stage connected but transparent: Chromium can defer decoding a detached video.
      if (video) { img.style.opacity = '0'; document.documentElement.append(img); }
      img.src = objectUrl;
      if (video) img.load();
      await Promise.race([ready ?? img.decode(), new Promise((_, reject) => { decodeTimer = setTimeout(() => reject(new Error('Wallpaper decoding timed out.')), 3200); })]);
    } finally { clearTimeout(decodeTimer); if (loaded) img.removeEventListener('loadeddata', loaded); if (failed) img.removeEventListener('error', failed); }
    const width = video ? img.videoWidth : img.naturalWidth, height = video ? img.videoHeight : img.naturalHeight;
    if (!width || !height || width * height > (video ? 8_294_400 : 40_000_000) || operation.cancelled) throw new Error('Wallpaper dimensions are invalid, exceed the limit, or loading was cancelled.');
    // Prove autoplay before replacing a working wallpaper. Hidden/reduced-motion views retain a still first frame.
    if (video && !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      let playTimer;
      try { await Promise.race([img.play(), new Promise((_, reject) => { playTimer = setTimeout(() => reject(new Error('Video playback timed out.')), 500); })]); }
      finally { clearTimeout(playTimer); }
    }
    if (operation.cancelled) throw new Error('Wallpaper loading was cancelled.');
    if (!document.getElementById('root') || !document.body) throw new Error('The reviewed app interface is unavailable.');
    let state = current;
    if (!state) {
      const layer = document.createElement('div'); layer.id = layerId; layer.setAttribute('aria-hidden', 'true');
      layer.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden';
      const veil = document.createElement('div'); veil.style.cssText = 'position:absolute;inset:0;pointer-events:none';
      const style = document.createElement('style'); style.id = styleId;
      style.textContent = makeStyle(runId);
      state = { runId, layer, veil, style, controls: null, surfaces: new Set(), image, img, objectUrl: null, timer: null, refreshTimer: null, observer: null, controllerError: null, mode: options.mode === 'session' ? 'session' : 'preview', hostCommand: null };
      state.motion = matchMedia('(prefers-reduced-motion: reduce)');
      state.onPlaybackChange = () => syncPlayback(state);
      document.addEventListener('visibilitychange', state.onPlaybackChange);
      state.motion.addEventListener('change', state.onPlaybackChange);
      Object.defineProperty(globalThis, key, { value: state, configurable: true });
      try {
        refreshSurfaces(state);
        document.documentElement.setAttribute(attribute, runId);
        document.head.append(style); document.documentElement.append(layer);
        const schedule = () => {
          clearTimeout(state.refreshTimer);
          state.refreshTimer = setTimeout(() => {
            if (globalThis[key] !== state) return;
            try { refreshSurfaces(state); } catch { dispose(state); }
          }, 250);
        };
        state.onResize = schedule; addEventListener('resize', schedule);
        state.observer = new MutationObserver(records => {
          if (records.some(record => !state.layer.contains(record.target) && !state.controls?.contains(record.target) && record.target !== state.style)) schedule();
        });
        state.observer.observe(document.getElementById('root'), { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
      } catch (error) { dispose(state); throw error; }
    }
    const previousUrl = state.objectUrl;
    const previousImg = state.img;
    state.image = { name: image.name, sha256: image.sha256, mime: image.mime }; state.img = img; state.objectUrl = objectUrl; state.settings = settings; state.controllerError = null;
    state.layer.prepend(img); state.layer.append(state.veil);
    img.style.removeProperty('opacity');
    if (previousImg !== img) releaseMedia(previousImg);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    paint(state);
    syncPlayback(state);
    if (state.mode === 'session' && options.persist !== false && !prepared) {
      try { await storage('put', { image, settings: state.settings }); }
      catch { /* Keep the current wallpaper when storage is unavailable. */ }
    }
    clearTimeout(state.timer); state.timer = setTimeout(() => dispose(state), ttlMs);
    committed = true;
    return status(state);
  } finally {
    if (!committed) { releaseMedia(img); if (objectUrl) URL.revokeObjectURL(objectUrl); }
    if (globalThis[loadingKey] === operation) delete globalThis[loadingKey];
  }
}

export const wallpaperExpression = (action, options) => `(${wallpaperRuntime.toString()})(${JSON.stringify(action)},${JSON.stringify(options)},${normalizeSettings.toString()},${parsePrismCommand.toString()},${browserImageInfo.toString()},${wallpaperStyle.toString()})`;
