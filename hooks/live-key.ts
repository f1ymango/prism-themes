// The live wallpaper player for a keyframe sent as data: the Svg draws only a flat colour and a 16 x 8 grid of SMIL
// cells (+ a clock) in its top left (viewBox 160 x 90, stretched). The shader collects 110 moments x 128 words of 24
// bits, decodes the picture from them once (8x8 DCT, YCoCg, chroma halved, Exp-Golomb), then moves it with the
// motion words, as hooks/live.ts does. The converter is notes/live-converter/key-svg.mjs; its header says the layout:
//   words 0..15 header (0 'PRL', 1-3 scales * 65536, 4 loop ms, 5 aspect * 1e6, 6-7 motion frame, 8 'KEY', 9 s * 4096)
//   16..1023 motion; 1024..1215 bit offset of each slice (Y block rows 0-95, Co 96-143, Cg 144-191); 1216.. stream.
// A block is se(DC change), ue(n <= 15), then n x (ue(zero run), se(level)) in zigzag order.
// Decoding: once every word is in, `B` finds where each block starts (each slice walks its blocks in parallel, 4 a
// frame). Then 12 frames each decode one band of 64 picture rows: `K` takes each block's (up to 16) coefficients out
// of the stream, `lumaBand`/`chromaBand` rebuild the band's pixels straight from them, and `pic` keeps the band. Every
// pass is small but `pic`, which only copies. Until a band is in, the window shows the Svg's flat colour there.
import { buffer, clamp, cos, floor, int, max, min, mod, picture, range, scene, shader, signed, sin, size, still, table, time, unsigned, values, vec2, vec3, vec4, type Buffer, type int as Int } from 'claude-code/shader'

// /prism livedebug: 1 draws the decoder's progress over the top of the window
const v = values({ debug: [0, 1] })

const CELLS = 128
const MOMENTS = 110
const WORDS = 14080
const S0 = 1216
// the coded picture: 1280 x 768, of which the top 760 rows show; 12 bands of 64 rows
const CH = 768
const PH = 760
const BANDS = 12

const cellAt = (i: number) => vec2((mod(i, 16) + 0.5) / 160, 1 - (floor(i / 16) + 0.5) / 90)
const word = (c: vec4): Int =>
  int(int(int(floor(c.r * 255 + 0.5)) << 16) | int(int(floor(c.g * 255 + 0.5)) << 8) | int(floor(c.b * 255 + 0.5)))

// the words, a row a moment; alpha 1 once seen
const acc: Buffer = buffer({ size: [128, 110], filter: 'nearest' }, q => {
  const old = acc.at(q.cell)
  const clock = scene.sample(vec2(0.5 / 160, 1 - 8.5 / 90))
  const ours = floor(clock.r * 255 + 0.5) === 165
  const now = floor(clock.g * 255 + 0.5) * 256 + floor(clock.b * 255 + 0.5)
  return ours && now === q.cell.y && old.a < 0.5 ? vec4(scene.sample(cellAt(q.cell.x)).rgb, 1) : old
})
const at = (s: number): Int => word(acc.at(vec2(s - floor(s / CELLS) * CELLS, floor(s / CELLS))))
const seen8: Buffer = buffer({ size: [16, 14], float: 32, filter: 'nearest' }, q => {
  let n = 0
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    const y = q.cell.y * 8 + j
    n = n + (y < MOMENTS ? acc.at(vec2(q.cell.x * 8 + i, y)).a : 0)
  }
  return vec4(n, 0, 0, 1)
})
// x: every word in and both marks right; y: words seen
const ready: Buffer = buffer({ size: [1, 1], float: 32, filter: 'nearest' }, () => {
  let n = 0
  for (let j = 0; j < 14; j++) for (let i = 0; i < 16; i++) n = n + seen8.at(vec2(i, j)).x
  const marks = signed(at(0)) === 5263948 && signed(at(8)) === 4932953
  return vec4(n > WORDS - 0.5 && marks ? 1 : 0, n, 0, 1)
})
// x: 0 until every block is placed, then 1..12 = decoding band x - 1 this frame, 13 = done (it stays)
const stage: Buffer = buffer({ size: [1, 1], float: 32, filter: 'nearest' }, () => {
  const s = stage.at(vec2(0, 0)).x
  return vec4(s > BANDS + 0.5 ? s : placed.at(vec2(0, 0)).x > 0.5 ? s + 1 : 0, 0, 0, 1)
})
const done = () => stage.at(vec2(0, 0)).x > BANDS + 0.5
const band = () => stage.at(vec2(0, 0)).x - 1

// --- the bit stream -----------------------------------------------------------------------------------------------
/** 32 bits of the stream from bit p, as an int (the first bit at the top) */
function window32(p: number): Int {
  const w = floor((p + 0.5) / 24)
  const o = p - w * 24
  const hi = at(S0 + w)
  const lo = at(S0 + w + 1)
  const tail = o > 15.5 ? int(lo << int(o - 16)) : int(lo >>> int(16 - o))
  return int(int(hi << int(8 + o)) | tail)
}
/** an Exp-Golomb code at bit p (at most 25 bits): x the value, y the bit after it */
function ueAt(p: number): vec2 {
  const all = window32(p)
  let r = all
  let z = 0
  const a16 = signed(int(r >>> 16)) === 0
  z = a16 ? z + 16 : z
  r = a16 ? int(r << 16) : r
  const a8 = signed(int(r >>> 24)) === 0
  z = a8 ? z + 8 : z
  r = a8 ? int(r << 8) : r
  const a4 = signed(int(r >>> 28)) === 0
  z = a4 ? z + 4 : z
  r = a4 ? int(r << 4) : r
  const a2 = signed(int(r >>> 30)) === 0
  z = a2 ? z + 2 : z
  r = a2 ? int(r << 2) : r
  z = signed(int(r >>> 31)) === 0 ? z + 1 : z
  return vec2(unsigned(int(all >>> int(31 - 2 * z))) - 1, p + 2 * z + 1)
}
function seAt(p: number): vec2 {
  const u = ueAt(p)
  return vec2(mod(u.x, 2) > 0.5 ? (u.x + 1) / 2 : 0 - u.x / 2, u.y)
}
/** walks one block from bit p: x the bit after it, y its DC (dc = the DC before it) */
function blockEnd(p: number, dc: number): vec2 {
  const d = seAt(p)
  const n = ueAt(d.y)
  let pos = n.y
  for (const i of range(15)) {
    const r = ueAt(pos)
    const l = seAt(r.y)
    pos = i < n.x ? l.y : pos
  }
  return vec2(pos, dc + d.x)
}
/** entry i of the block at bit p: x its zigzag index, y its level (entry 0 is the DC; past the last, level 0) */
function entry(p: number, dc: number, i: number): vec2 {
  const d = seAt(p)
  const n = ueAt(d.y)
  let pos = n.y
  let k = 0
  let lev = 0
  for (const j of range(15)) {
    const r = ueAt(pos)
    const l = seAt(r.y)
    const live = j < n.x && j < i
    k = live ? k + r.x + 1 : k
    lev = live && j > i - 1.5 ? l.x : lev
    pos = live ? l.y : pos
  }
  return i < 0.5 ? vec2(0, dc + d.x) : i < n.x + 0.5 ? vec2(k, lev) : vec2(0, 0)
}

// zigzag index -> raster position; quantisers (raster order); the 8-point inverse DCT basis, [x * 8 + u]
const ZZ = table([0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63], 'int')
const QL = table([16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99], 'int')
const QC = table([17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99], 'int')
const C8 = table([0.35355, 0.49039, 0.46194, 0.41573, 0.35355, 0.27779, 0.19134, 0.09755, 0.35355, 0.41573, 0.19134, -0.09755, -0.35355, -0.49039, -0.46194, -0.27779, 0.35355, 0.27779, -0.19134, -0.49039, -0.35355, 0.09755, 0.46194, 0.41573, 0.35355, 0.09755, -0.46194, -0.27779, 0.35355, 0.41573, -0.19134, -0.49039, 0.35355, -0.09755, -0.46194, 0.27779, 0.35355, -0.41573, -0.19134, 0.49039, 0.35355, -0.27779, -0.19134, 0.49039, -0.35355, -0.09755, 0.46194, -0.41573, 0.35355, -0.41573, 0.19134, 0.09755, -0.35355, 0.49039, -0.46194, 0.27779, 0.35355, -0.49039, 0.46194, -0.41573, 0.35355, -0.27779, 0.19134, -0.09755])

// --- decoding, once every word is in -------------------------------------------------------------------------------
const going = () => ready.at(vec2(0, 0)).x > 0.5 && !done()
// per slice (y) and block (x): x the block's first bit, y the DC before it, z 1 once known. A block becomes known when
// the one before it is; 4 runs a frame, so the 160 blocks of a row take 40 frames.
const B: Buffer = buffer({ size: [160, 192], float: 32, filter: 'nearest', repeat: 4 }, q => {
  if (!going()) return vec4(0)
  const old = B.at(q.cell)
  if (old.z > 0.5) return old
  const b = q.cell.x
  const sl = q.cell.y
  if (b > (sl < 96 ? 159.5 : 79.5)) return vec4(0, 0, 1, 1)
  if (b < 0.5) return vec4(signed(at(1024 + sl)), 0, 1, 1)
  const prev = B.at(vec2(b - 1, sl))
  if (prev.z < 0.5) return old
  const e = blockEnd(prev.x, prev.y)
  return vec4(e.x, e.y, 1, 1)
})
// x: 1 once every slice's last block is known
const placed: Buffer = buffer({ size: [1, 1], float: 32, filter: 'nearest' }, () => {
  let all = 1
  for (const sl of range(192)) all = all * B.at(vec2(sl < 96 ? 159 : 79, sl)).z
  return vec4(all > 0.5 && going() ? 1 : 0, 0, 0, 1)
})
const S = () => signed(at(9)) / 4096
const decoding = () => stage.at(vec2(0, 0)).x > 0.5 && !done()

// this frame's band, per block: 16 entries, entry i at x = block * 8 + i % 8, y = row * 2 + floor(i / 8), where
// rows 0-7 are Y block rows, 8-11 Co, 12-15 Cg (a side holds at most 2048).
const K: Buffer = buffer({ size: [1280, 32], float: 32, filter: 'nearest' }, q => {
  if (!decoding()) return vec4(0)
  const t = band()
  const bx = floor(q.cell.x / 8)
  const j = floor(q.cell.y / 2)
  const i = q.cell.x - bx * 8 + (q.cell.y - j * 2) * 8
  const sl = j < 7.5 ? t * 8 + j : j < 11.5 ? 96 + t * 4 + j - 8 : 144 + t * 4 + j - 12
  if (j > 7.5 && bx > 79.5) return vec4(0)
  const info = B.at(vec2(bx, sl))
  const e = entry(info.x, info.y, i)
  return vec4(e, 0, 1)
})
// a pixel of a block from its 16 entries: row k of K, block bx, at (xi, yi) inside it
function rebuild(k: number, bx: number, xi: number, yi: number, chroma: boolean): number {
  let s = 0
  for (const i of range(16)) {
    const e = K.at(vec2(bx * 8 + mod(i, 8), k * 2 + floor(i / 8)))
    const pos = signed(ZZ.at(e.x))
    const u = mod(pos, 8)
    const w = floor(pos / 8)
    const qv = signed(chroma ? QC.at(pos) : QL.at(pos))
    s = s + e.y * qv * C8.at(xi * 8 + u) * C8.at(yi * 8 + w)
  }
  return s * S() + 128
}
// this frame's band of the picture: 1280 x 64 luma, 640 x 32 chroma (row 0 at the top: y = rows - 1 - cell.y)
const lumaBand: Buffer = buffer({ size: [1280, 64], float: 16, filter: 'nearest' }, q => {
  if (!decoding()) return vec4(0)
  const rr = 63 - q.cell.y
  const bx = floor(q.cell.x / 8)
  const by = floor(rr / 8)
  return vec4(rebuild(by, bx, q.cell.x - bx * 8, rr - by * 8, false), 0, 0, 1)
})
const chromaBand: Buffer = buffer({ size: [640, 32], float: 16, filter: 'nearest' }, q => {
  if (!decoding()) return vec4(0)
  const rr = 31 - q.cell.y
  const bx = floor(q.cell.x / 8)
  const by = floor(rr / 8)
  const xi = q.cell.x - bx * 8
  const yi = rr - by * 8
  return vec4(rebuild(8 + by, bx, xi, yi, true), rebuild(12 + by, bx, xi, yi, true), 0, 1)
})
const chromaAt = (x: number, y: number) => chromaBand.at(vec2(x, 31 - y)).xy
// the picture, painted a band a frame and kept (alpha 1 where painted)
const pic: Buffer = buffer({ size: [1280, 768], filter: 'linear', wrap: 'clamp' }, q => {
  const old = pic.at(q.cell)
  if (!decoding()) return stage.at(vec2(0, 0)).x < 0.5 ? vec4(0) : old
  const t = band()
  const rr = CH - 1 - q.cell.y - t * 64
  if (rr < -0.5 || rr > 63.5) return old
  const yv = lumaBand.at(vec2(q.cell.x, 63 - rr)).x
  // chroma sits between luma pixels: blend the four nearest, within this band
  const cx = clamp((q.cell.x + 0.5) / 2 - 0.5, 0, 639)
  const cy = clamp((rr + 0.5) / 2 - 0.5, 0, 31)
  const x0 = floor(cx)
  const y0 = floor(cy)
  const x1 = min(x0 + 1, 639)
  const y1 = min(y0 + 1, 31)
  const ax = cx - x0
  const ay = cy - y0
  const c = vec2(mix2(mix2(chromaAt(x0, y0), chromaAt(x1, y0), ax), mix2(chromaAt(x0, y1), chromaAt(x1, y1), ax), ay))
  const o = c.x - 128
  const g = c.y - 128
  return vec4(clamp(vec3(yv + o - g, yv + g, yv - o - g) / 255, 0, 1), 1)
})
function mix2(a: vec2, b: vec2, t: number): vec2 {
  return vec2(a + (b - a) * t)
}

// --- motion, as live.ts ---------------------------------------------------------------------------------------------
const field = (w: Int, shift: number) => {
  const z = int((w >> shift) & 63)
  return signed(int((z >> 1) ^ (0 - (z & 1))))
}
const sway: Buffer = buffer({ size: [24, 14], float: 16, filter: 'linear', wrap: 'clamp' }, q => {
  const n = (13 - q.cell.y) * 24 + q.cell.x
  const loop = max(signed(at(4)), 1000) / 1000
  const fw = max(signed(at(6)), 1)
  const fh = max(signed(at(7)), 1)
  const ph = time * (1 - still) * 6.2831853 / loop
  let dx = 0
  let dy = 0
  for (const h of [1, 2, 3]) {
    const w = at(16 + n * 3 + h - 1)
    const k = signed(at(h)) / 65536 / 31
    const c = cos(ph * h) - 1
    const s = sin(ph * h)
    dx = dx + (field(w, 18) * c + field(w, 12) * s) * k / fw
    dy = dy + (field(w, 6) * c + field(w, 0) * s) * k / fh
  }
  const on = done() ? 1 : 0
  return vec4(dx * on, dy * on, 0, 1)
})

export default shader({
  fps: 30,
  passes: [acc, seen8, ready, stage, B, placed, K, lumaBand, chromaBand, pic, sway, picture(q => {
    const pa = signed(at(5)) / 1000000
    const a = pa > 0.1 ? pa : 1.684
    const aspect = size.x / size.y
    const fx = min(1, aspect / a)
    const fy = min(1, a / aspect)
    const p = vec2(0.5 + (q.uv.x - 0.5) * fx, 0.5 + (q.uv.y - 0.5) * fy)
    const d = sway.sample(p)
    const from = vec2(p.x - d.x, p.y + d.y)
    const c = pic.sample(vec2(from.x, (CH - PH) / CH + from.y * PH / CH))
    const flat = scene.sample(vec2(0.99, 0.02)).rgb
    const img = c.a > 0.5 ? c.rgb : flat
    if (v.debug < 0.5 || q.uv.y < 0.9) return vec4(img, 1)
    // debug strip: words seen (green, top), then the stage: blocks placing (yellow), bands (white, growing)
    const r = ready.at(vec2(0, 0))
    const st = stage.at(vec2(0, 0)).x
    const top = q.uv.y > 0.95
    const bar = top ? q.uv.x < r.y / WORDS : q.uv.x < (st > 0.5 ? st / (BANDS + 1) : r.x > 0.5 ? 0.05 : 0)
    return vec4(bar ? (top ? vec3(0.1, 0.8, 0.2) : st > 0.5 ? vec3(1) : vec3(1, 0.85, 0.1)) : vec3(0.15), 1)
  })],
})
