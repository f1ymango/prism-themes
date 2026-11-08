import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { loadLocalImage } from '../src/media.mjs';
import { normalizeSettings, readWallpaperConfig } from '../src/settings.mjs';
import { wallpaperExpression } from '../src/wallpaper.mjs';
import { readinessExpression } from '../src/renderer.mjs';
import { runExperiment } from '../src/experiment.mjs';

try {
  const { values } = parseArgs({ options: {
    'app-dir': { type: 'string' }, config: { type: 'string' }, image: { type: 'string' },
    dim: { type: 'string' }, fit: { type: 'string' }, position: { type: 'string' },
    'no-controls': { type: 'boolean' }, 'preview-seconds': { type: 'string' },
  } });
  const config = await readWallpaperConfig(resolve(values.config ?? 'examples/static-wallpaper.json'));
  const settings = normalizeSettings({
    ...config.settings,
    ...(values.dim !== undefined ? { dim: Number(values.dim) } : {}),
    ...(values.fit ? { fit: values.fit } : {}),
    ...(values.position ? { position: values.position } : {}),
    ...(values['no-controls'] ? { controls: false } : {}),
  });
  const previewSeconds = Number(values['preview-seconds'] ?? 0);
  if (!Number.isInteger(previewSeconds) || previewSeconds < 0 || previewSeconds > 90) throw new Error('Preview duration must be an integer from 0 to 90 seconds.');
  // Resolve and validate file bytes before launching any desktop process.
  const image = await loadLocalImage(resolve(values.image ?? config.image));
  const alternate = previewSeconds ? null : await loadLocalImage(resolve('assets/prism-plum.png'));
  const report = await runExperiment({ name: previewSeconds ? 'wallpaper-preview' : 'wallpaper-proof', appDir: values['app-dir'], async main(context) {
    const call = (action, extra = {}) => context.evaluate(wallpaperExpression(action, { runId: context.runId, ...extra }));
    context.onCleanup(async () => { await call('remove'); });
    context.report.image = { ...image, dataBase64: undefined };
    context.report.settings = settings;
    const surfaces = `(() => [...document.querySelectorAll('#root .bg-surface')].filter(element=>{
      const rect=element.getBoundingClientRect();return rect.width>=innerWidth*.85&&rect.height>=innerHeight*.85;
    }).map(element=>getComputedStyle(element).backgroundColor))()`;
    context.report.surfaceColorsBefore = await context.evaluate(surfaces);
    await context.screenshot('baseline.png');
    context.report.applied = await call('apply', { image, settings });
    assert.equal(context.report.applied.count, 1);
    assert.equal(context.report.applied.visible, true);
    assert.equal(context.report.applied.pointerEvents, 'none');
    assert.equal(context.report.applied.ariaHidden, 'true');
    assert.ok(context.report.applied.surfaceCount > 0, 'No reviewed background surfaces were mapped.');
    await context.pause(400);
    await context.screenshot('wallpaper-visible.png');
    context.report.checks.localImageDecoded = true;
    context.report.checks.reviewedSurfacesMapped = true;
    const ownUrl = () => context.evaluate('globalThis.__prismWallpaperV1?.objectUrl ?? null');
    const revoked = url => context.evaluate(`fetch(${JSON.stringify(url)}).then(()=>false,()=>true)`);
    if (previewSeconds) {
      console.log(JSON.stringify({ stage: 'preview-open', seconds: previewSeconds, image: image.name }));
      for (let second = 0; second < previewSeconds; second++) await context.pause(1000);
      context.report.previewFinal = await call('status');
      await call('remove');
      context.report.checks.previewCompleted = true;
      return;
    }

    let previousUrl = await ownUrl();
    context.report.reapplied = await call('apply', { image, settings });
    assert.equal(context.report.reapplied.count, 1);
    assert.equal(context.report.reapplied.controlsCount, settings.controls ? 1 : 0);
    assert.equal(await revoked(previousUrl), true);
    context.report.checks.reapplyDoesNotDuplicate = true;
    context.report.checks.replacedUrlRevoked = true;
    const beforeSettingsUrl = await ownUrl();
    context.report.updated = await call('update', { settings: { dim: .65, fit: 'contain', position: 'top' } });
    assert.equal(context.report.updated.settings.dim, .65);
    assert.equal(await ownUrl(), beforeSettingsUrl);
    const renderedSettings = await context.evaluate(`(() => {
      const state=globalThis.__prismWallpaperV1;
      return {fit:getComputedStyle(state.img).objectFit,position:getComputedStyle(state.img).objectPosition,dim:getComputedStyle(state.veil).opacity};
    })()`);
    assert.deepEqual(renderedSettings, { fit: 'contain', position: '50% 0%', dim: '0.65' });
    context.report.checks.settingsChangeWithoutReload = true;

    await call('update', { settings: { controls: true } });
    context.report.controllerSettings = await context.evaluate(`(() => {
      const shadow=document.getElementById('prism-wallpaper-controls-v1').shadowRoot;
      const dim=shadow.querySelector('[name="dim"]');dim.value='42';dim.dispatchEvent(new Event('input'));
      const fit=shadow.querySelector('[name="fit"]');fit.value='cover';fit.dispatchEvent(new Event('change'));
      const position=shadow.querySelector('[name="position"]');position.value='right';position.dispatchEvent(new Event('change'));
      return {...globalThis.__prismWallpaperV1.settings};
    })()`);
    assert.deepEqual(context.report.controllerSettings, { dim: .42, fit: 'cover', position: 'right', controls: true });
    context.report.checks.previewControlsWork = true;
    await assert.rejects(call('update', { settings: { dim: -1 } }), /Dim must/);
    context.report.checks.invalidSettingsRejected = true;

    const lastGood = await call('status');
    await assert.rejects(call('apply', { image: { ...image, dataBase64: image.dataBase64.slice(0, 48) }, settings }), /Probe script failed/);
    const afterBadImage = await call('status');
    assert.deepEqual(afterBadImage.image, lastGood.image);
    assert.deepEqual(afterBadImage.settings, lastGood.settings);
    assert.equal(afterBadImage.count, 1);
    context.report.checks.badImagePreservesLastGood = true;

    context.report.formats = [];
    for (const [mime, extension] of [['image/jpeg', 'jpg'], ['image/webp', 'webp']]) {
      const encoded = await context.evaluate(`(() => {
        const img=globalThis.__prismWallpaperV1.img,canvas=document.createElement('canvas');
        canvas.width=Math.min(img.naturalWidth,640);canvas.height=Math.max(1,Math.round(img.naturalHeight*canvas.width/img.naturalWidth));
        canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
        return canvas.toDataURL(${JSON.stringify(mime)},.82);
      })()`);
      assert.ok(encoded.startsWith(`data:${mime};base64,`), `The runtime did not encode ${mime}.`);
      const formatPath = resolve(context.runDir, `format-test.${extension}`);
      await writeFile(formatPath, Buffer.from(encoded.split(',')[1], 'base64'), { flag: 'wx' });
      const formatImage = await loadLocalImage(formatPath);
      const decoded = await call('apply', { image: formatImage, settings: { ...settings, controls: false } });
      assert.equal(decoded.image.width, formatImage.width);
      assert.equal(decoded.image.height, formatImage.height);
      context.report.formats.push({ mime: formatImage.mime, width: decoded.image.width, height: decoded.image.height, bytes: formatImage.bytes });
    }
    context.report.checks.jpegAndWebpDecodedFromLocalFiles = true;

    previousUrl = await ownUrl();
    context.report.switched = await call('apply', { image: alternate, settings: { ...settings, fit: 'contain', position: 'center', controls: false } });
    assert.equal(context.report.switched.image.width, alternate.width);
    assert.equal(context.report.switched.image.height, alternate.height);
    assert.equal(context.report.switched.activeObjectUrls, 1);
    assert.equal(await revoked(previousUrl), true);
    await context.screenshot('wallpaper-portrait.png');
    context.report.checks.imageSwitchAndContain = true;

    await context.client.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 650, deviceScaleFactor: 1, mobile: false }, { sessionId: context.sessionId });
    await context.pause(700);
    const resized = await context.evaluate(`(() => { const rect=document.getElementById('prism-wallpaper-v1').getBoundingClientRect();return {width:rect.width,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight}; })()`);
    assert.equal(resized.width, resized.viewportWidth);
    assert.equal(resized.height, resized.viewportHeight);
    await context.screenshot('wallpaper-resized.png');
    await context.client.send('Emulation.clearDeviceMetricsOverride', {}, { sessionId: context.sessionId });
    await context.pause(500);
    context.report.resized = resized;
    context.report.checks.emulatedViewportResize = true;

    await call('apply', { image, settings: { ...settings, controls: true } });
    previousUrl = await ownUrl();
    await context.evaluate("document.getElementById('prism-wallpaper-controls-v1').shadowRoot.querySelector('[data-command=restore]').click()");
    context.report.removed = await call('status');
    assert.equal(context.report.removed.count, 0);
    assert.equal(context.report.removed.controlsCount, 0);
    assert.equal(context.report.removed.ownedSurfaceAttributes, 0);
    assert.equal(context.report.removed.stylePresent, false);
    assert.equal(context.report.removed.rootAttributePresent, false);
    assert.equal(await revoked(previousUrl), true);
    context.report.surfaceColorsAfter = await context.evaluate(surfaces);
    assert.deepEqual(context.report.surfaceColorsAfter, context.report.surfaceColorsBefore);
    await context.screenshot('wallpaper-removed.png');
    context.report.checks.restoreButtonRemovesAllOwnedChanges = true;

    await call('apply', { image, settings: { ...settings, controls: false }, ttlMs: 300 });
    previousUrl = await ownUrl();
    const deadline = Date.now() + 5000;
    do {
      await context.pause(200);
      context.report.expired = await call('status');
    } while (context.report.expired.installed && Date.now() < deadline);
    assert.equal(context.report.expired.count, 0);
    assert.equal(context.report.expired.ownedSurfaceAttributes, 0);
    assert.equal(context.report.expired.stylePresent, false);
    assert.equal(await revoked(previousUrl), true);
    context.report.checks.automaticExpiryRestoresApp = true;
    const after = await context.evaluate(readinessExpression);
    assert.equal(after.visibleControls, context.ready.visibleControls);
    context.report.checks.nativeControlCountPreserved = true;
  } });
  if (report.result !== 'passed') process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
