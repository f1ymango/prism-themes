// Dependency-free byte validation for the in-app file picker; no file-name trust.
export function browserImageInfo(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 15 * 1024 * 1024) throw new Error('Choose an image no larger than 15 MiB.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  let mime, width, height;
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((value, i) => bytes[i] === value)) {
    if (bytes.length < 33 || text(12, 4) !== 'IHDR' || view.getUint32(8) !== 13) throw new Error('Invalid PNG image.');
    mime = 'image/png'; width = view.getUint32(16); height = view.getUint32(20);
    let ended = false, data = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = view.getUint32(offset), type = text(offset + 4, 4);
      if (offset + size + 12 > bytes.length) throw new Error('Truncated PNG image.');
      if (type === 'acTL') throw new Error('Choose a static PNG image.');
      if (type === 'IDAT') data = true;
      offset += size + 12;
      if (type === 'IEND') { ended = size === 0 && offset === bytes.length; break; }
    }
    if (!ended || !data) throw new Error('Truncated PNG image.');
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    mime = 'image/jpeg';
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 255) throw new Error('Invalid JPEG image.');
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if ([217,218].includes(marker)) break;
      if (marker === 1 || (marker >= 208 && marker <= 216)) continue;
      if (offset + 2 > bytes.length) break;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) throw new Error('Truncated JPEG image.');
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if (size < 8) throw new Error('Invalid JPEG frame.');
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += size;
    }
  } else if (bytes.length >= 20 && text(0,4) === 'RIFF' && text(8,4) === 'WEBP') {
    mime = 'image/webp';
    if (view.getUint32(4,true) + 8 !== bytes.length) throw new Error('Invalid WebP image.');
    const u24 = offset => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = text(offset,4), size = view.getUint32(offset + 4,true), data = offset + 8;
      if (data + size > bytes.length) throw new Error('Truncated WebP image.');
      if (['ANIM','ANMF'].includes(type)) throw new Error('Choose a static WebP image.');
      if (type === 'VP8X') {
        if (size < 10 || bytes[data] & 2) throw new Error('Choose a static WebP image.');
        width = u24(data + 4) + 1; height = u24(data + 7) + 1;
      } else if (type === 'VP8 ' && !width) {
        if (size < 10 || bytes[data + 3] !== 157 || bytes[data + 4] !== 1 || bytes[data + 5] !== 42) throw new Error('Invalid WebP frame.');
        width = view.getUint16(data + 6,true) & 16383; height = view.getUint16(data + 8,true) & 16383;
      } else if (type === 'VP8L' && !width) {
        if (size < 5 || bytes[data] !== 47) throw new Error('Invalid WebP frame.');
        const dimensions = view.getUint32(data + 1,true);
        width = (dimensions & 16383) + 1; height = ((dimensions >>> 14) & 16383) + 1;
      }
      offset = data + size + size % 2;
    }
  } else throw new Error('Choose a static PNG, JPEG, or WebP image.');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 40000000) throw new Error('Choose an image with at most 40 million pixels.');
  return { mime, width, height };
}
