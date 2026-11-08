import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { wallpaperExpression } from './wallpaper.mjs';

export const MEDIA_CHUNK_BYTES = 512 * 1024;

// Keep file bytes out of large Runtime.evaluate messages and host caches. A changed
// file is rejected before apply, leaving the existing wallpaper intact.
export async function transferVideo(renderer, filename, media, options, { shouldAbort } = {}) {
  const call = (action, extra = {}) => renderer.evaluate(wallpaperExpression(action, { ...options, ...extra }));
  const { name, mime, bytes, sha256 } = media;
  const { transferId } = await call('transfer-start', { image: { name, mime, bytes, sha256 } });
  let file, completed = false;
  try {
    file = await open(filename, 'r');
    const hash = createHash('sha256'), buffer = Buffer.alloc(MEDIA_CHUNK_BYTES);
    let received = 0, index = 0, renewed = Date.now();
    for (;;) {
      if (await shouldAbort?.()) { const error = new Error('Video transfer cancelled.'); error.code = 'PRISM_TRANSFER_CANCELLED'; throw error; }
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      received += bytesRead;
      if (received > media.bytes) throw new Error('Wallpaper file changed while loading.');
      const bytes = buffer.subarray(0, bytesRead); hash.update(bytes);
      await call('transfer-chunk', { transferId, index: index++, dataBase64: bytes.toString('base64') });
      if (Date.now() - renewed > 3000) { await call('renew'); renewed = Date.now(); }
    }
    if (received !== media.bytes || hash.digest('hex') !== media.sha256) throw new Error('Wallpaper file changed while loading.');
    const result = await call('apply', { image: { transferId }, settings: options.settings, restoreSaved: false });
    completed = true;
    return result;
  } finally {
    await file?.close();
    if (!completed) await call('transfer-abort', { transferId }).catch(() => {});
  }
}
