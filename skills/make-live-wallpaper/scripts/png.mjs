// Minimal PNG write (grey or RGB, 8-bit) and read (8-bit grey, grey+alpha, RGB, RGBA, palette; not interlaced),
// enough to hand a mask to a person and read back what their paint program saved.
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; return c >>> 0 })
const crc = b => { let c = ~0; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return ~c >>> 0 }
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
export function writePNG(path, w, h, data, ch = 3) {
  const raw = Buffer.alloc((w * ch + 1) * h)
  for (let y = 0; y < h; y++) Buffer.from(data.buffer, data.byteOffset + y * w * ch, w * ch).copy(raw, y * (w * ch + 1) + 1)
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = ch === 1 ? 0 : 2
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}
// returns { w, h, rgb: Uint8Array w*h*3 }
export function readPNG(path) {
  const b = readFileSync(path); let o = 8, w, h, depth, type, inter, pal, idat = []
  while (o < b.length) {
    const len = b.readUInt32BE(o), t = b.toString('latin1', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len); o += 12 + len
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; inter = d[12] }
    else if (t === 'PLTE') pal = d
    else if (t === 'IDAT') idat.push(d)
  }
  if (depth !== 8 || inter) throw new Error(`${path}: only 8-bit, non-interlaced PNGs are read (save it as a 24-bit PNG)`)
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type], raw = inflateSync(Buffer.concat(idat)), st = w * ch
  const px = Buffer.alloc(st * h)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (st + 1)], src = raw.subarray(y * (st + 1) + 1, (y + 1) * (st + 1)), row = px.subarray(y * st, (y + 1) * st), up = y ? px.subarray((y - 1) * st, y * st) : null
    for (let i = 0; i < st; i++) {
      const a = i >= ch ? row[i - ch] : 0, u = up ? up[i] : 0, c = up && i >= ch ? up[i - ch] : 0
      let v = src[i]
      if (f === 1) v += a; else if (f === 2) v += u; else if (f === 3) v += (a + u) >> 1
      else if (f === 4) { const p = a + u - c, pa = Math.abs(p - a), pb = Math.abs(p - u), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? u : c }
      row[i] = v & 255
    }
  }
  const rgb = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    if (type === 3) { const k = px[i]; rgb.set(pal.subarray(k * 3, k * 3 + 3), i * 3) }
    else if (ch <= 2) rgb.fill(px[i * ch], i * 3, i * 3 + 3)
    else rgb.set(px.subarray(i * ch, i * ch + 3), i * 3)
  }
  return { w, h, rgb }
}
