// The live wallpaper player for a keyframe sent as data: the Svg draws only a flat colour and a 16 x 8 grid of SMIL
// cells (+ a clock) in its top left (viewBox 160 x 90, stretched). The shader collects 110 moments x 128 words of 24
// bits, decodes the picture from them once (intra-predicted 8x8 blocks + DCT residuals, YCoCg, chroma halved,
// range-coded with static per-picture tables), then moves it with the motion words, as hooks/live.ts does. The
// converter is notes/live-converter/arith-svg.mjs; its header says the layout:
//   words 0..15 header (0 'PRL', 1-3 scales * 65536, 4 loop ms, 5 aspect * 1e6, 6-7 motion frame, 8 'KA1', 9 s * 4096,
//   10 the stream's first word); 16..1023 motion; 1024..1215 bit offset of each slice (Y block rows 0-95, Co 96-143,
//   Cg 144-191); 1216..1258 quantisers (luma 64 then chroma 64, a byte each, 3 a word, high byte first); 1259..1330
//   each context's table offset (12 bits, 2 a word); 1331.. the tables (cumulative frequencies of 256, a byte each).
// A block is [mode letter] DC class + low bits, n (<= 15), then n x (run class, level class, low bits + sign).
// Decoding: once every word is in, D runs one range decoder per slice, a block a run, REP runs a frame, and P keeps
// every block's numbers. Then 54 frames rebuild the picture: tiles of 320 x 64 pixels (160 x 32 for chroma) predict
// only from inside themselves, so all 48 rebuild together, a diagonal of blocks a frame (K takes those blocks'
// coefficients from P, W predicts + adds the residual, rec keeps the planes). Then 12 frames paint pic from rec a
// band of 64 rows at a time, deblocked a frame later. Until then the window shows the Svg's flat colour.
import { abs, buffer, clamp, cos, floor, int, max, min, mod, picture, range, scene, shader, signed, sin, size, still, table, time, unsigned, values, vec2, vec3, vec4, type Buffer, type int as Int } from 'claude-code/shader'

// /prism livedebug: 1 draws the decoder's progress over the top of the window
const v = values({ debug: [0, 1] })

const CELLS = 128
const MOMENTS = 110
const WORDS = 14080
const T0 = 1216
// symbol tables: each context's offset (12 bits, 2 a word, contexts 0..143), then the bytes
const CT0 = 1259
const CB0 = 1331
// the coded picture: 1280 x 768, of which the top 760 rows show; 12 bands of 64 rows
const CH = 768
const PH = 760
const BANDS = 12
// rebuild steps: a 40 x 8 block tile takes 40 + 2 x 7 diagonals (a block needs its left, above and above-right blocks)
const REC = 54

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
// control: rows 0..13 the words seen in each 8 x 8 cells of acc; row 14: x 0 the stage, x 1 ready (x: every word in and
// both marks right, y: words seen). The stage: 0 until every block is placed, then 1..REC = rebuild step x - 1, then
// REC+1..REC+12 = painting band x - REC - 1 (REC+2..REC+13 also deblock window x - REC - 2), REC + 14 = done (it stays)
function seenCell(cx: number, cy: number): number {
  let n = 0
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    const y = cy * 8 + j
    n = n + (y < MOMENTS ? acc.at(vec2(cx * 8 + i, y)).a : 0)
  }
  return n
}
function readyNow(): vec4 {
  let n = 0
  for (let j = 0; j < 14; j++) for (let i = 0; i < 16; i++) n = n + ctl.at(vec2(i, j)).x
  const marks = signed(at(0)) === 5263948 && signed(at(8)) === 4931889
  return vec4(n > WORDS - 0.5 && marks ? 1 : 0, n, 0, 1)
}
function stageNext(): vec4 {
  const s = ctl.at(vec2(0, 14)).x
  // every slice's last block known
  let all = 1
  for (const sl of range(192)) all = all * (P.at(vec2(sl < 96 ? 636 : 316, sl)).x > 0.5 ? 1 : 0)
  return vec4(s > REC + BANDS + 1.5 ? s : all > 0.5 && going() ? s + 1 : 0, 0, 0, 1)
}
const ctl: Buffer = buffer({ size: [16, 15], float: 32, filter: 'nearest' }, q => {
  if (q.cell.y < 13.5) return vec4(seenCell(q.cell.x, q.cell.y), 0, 0, 1)
  if (q.cell.x > 1.5) return vec4(0)
  return q.cell.x > 0.5 ? readyNow() : stageNext()
})
const stageNow = () => ctl.at(vec2(0, 14)).x
const done = () => stageNow() > REC + BANDS + 1.5
const rebuilding = () => stageNow() > 0.5 && stageNow() < REC + 0.5
const rstep = () => stageNow() - 1
const band = () => stageNow() - REC - 1

// --- the stream: range-coded letters ---------------------------------------------------------------------------------
const SS = () => signed(at(10))
/** 32 bits of the stream from bit p, as an int (the first bit at the top) */
function window32(p: number): Int {
  const w = floor((p + 0.5) / 24)
  const o = p - w * 24
  const hi = at(SS() + w)
  const lo = at(SS() + w + 1)
  const tail = o > 15.5 ? int(lo << int(o - 16)) : int(lo >>> int(16 - o))
  return int(int(hi << int(8 + o)) | tail)
}
/** the n bits (0..24) of the stream from bit p, as a number */
const bitsAt = (p: number, n: number) => (n < 0.5 ? 0 : unsigned(int(window32(p) >>> int(32 - n))))
/** 2^e, e an integer 0..19 */
function qPow(e: number): number {
  let p = 1
  for (let j = 0; j < 19; j++) p = j < e - 0.5 ? p * 2 : p
  return p
}
/** byte t of the symbol tables */
/** a mod n for whole numbers a, n, safe from a GPU's inexact division (a / n can land just under a whole number) */
function imod(a: number, n: number): number {
  return a - n * floor((a + 0.5) / n)
}
function tByte(t: number): number {
  const w = signed(at(CB0 + floor((t + 0.5) / 3)))
  const r = imod(t, 3)
  return mod(floor(w / (r < 0.5 ? 65536 : r < 1.5 ? 256 : 1)), 256)
}
/** where context c's table starts (its length: the next one's start minus this) */
function tOff(c: number): number {
  const w = signed(at(CT0 + floor(c / 2)))
  return mod(c, 2) < 0.5 ? floor(w / 4096) : mod(w, 4096)
}
// context buckets: the left block's entry count, the zigzag index before a run, a level's zigzag index, entries left
const nBk = (v: number) => (v > 0.5 ? 1 : 0) + (v > 2.5 ? 1 : 0) + (v > 5.5 ? 1 : 0)
const runBk = (v: number) => (v > 0.5 ? 1 : 0) + (v > 2.5 ? 1 : 0) + (v > 5.5 ? 1 : 0) + (v > 9.5 ? 1 : 0) + (v > 19.5 ? 1 : 0)
const posBk = (v: number) =>
  (v > 1.5 ? 1 : 0) + (v > 2.5 ? 1 : 0) + (v > 4.5 ? 1 : 0) + (v > 7.5 ? 1 : 0) + (v > 11.5 ? 1 : 0) + (v > 19.5 ? 1 : 0) + (v > 31.5 ? 1 : 0)
const remBk = (v: number) => (v > 1.5 ? 1 : 0) + (v > 2.5 ? 1 : 0)
// A decoder state is a vec4: x V, y R, z the next bit of the stream, w the value just decoded. Every product below
// stays under 2^24, so floats hold it exactly.
/** shifts R back into [2^23, 2^24), taking as many new bits into V */
function renorm(V: number, R: number, p: number, s: number): vec4 {
  let r = R
  let m = 1
  let sh = 0
  const a = r < 256
  r = a ? r * 65536 : r
  m = a ? m * 65536 : m
  sh = a ? sh + 16 : sh
  const b = r < 65536
  r = b ? r * 256 : r
  m = b ? m * 256 : m
  sh = b ? sh + 8 : sh
  const c = r < 1048576
  r = c ? r * 16 : r
  m = c ? m * 16 : m
  sh = c ? sh + 4 : sh
  const e = r < 4194304
  r = e ? r * 4 : r
  m = e ? m * 4 : m
  sh = e ? sh + 2 : sh
  const f = r < 8388608
  r = f ? r * 2 : r
  m = f ? m * 2 : m
  sh = f ? sh + 1 : sh
  return vec4(V * m + bitsAt(p, sh), r, p + sh, s)
}
// the tables unpacked: context c (y), letter i (x): x where the letter starts (of 256); past the last letter, 1e9.
// Row 0 also holds constants by i: y value class i's first value, z how many low bits follow it, w 2^i (i 0..19)
const Q: Buffer = buffer({ size: [20, 144], float: 32, filter: 'nearest' }, q => {
  const i = q.cell.x
  const h = floor(i / 2)
  const first = i < 3.5 ? i : (2 + mod(i, 2)) * qPow(h - 1)
  const extra = i < 3.5 ? 0 : i > 14.5 ? 13 : h - 1
  const k = q.cell.y < 0.5 ? vec3(first, extra, qPow(i)) : vec3(0)
  if (!going() || i > 15.5) return vec4(0, k.x, k.y, k.z)
  const off = tOff(q.cell.y)
  const last = tOff(q.cell.y + 1) - off
  return vec4(i < 0.5 ? 0 : i > last + 0.5 ? 1000000000 : tByte(off + i - 1), k.x, k.y, k.z)
})
const BASEof = (i: number) => Q.at(vec2(i, 0)).y
const EXTof = (i: number) => Q.at(vec2(i, 0)).z
const POWof = (i: number) => Q.at(vec2(i, 0)).w
/** one letter of context c (the largest s with floor(R / 256) * cdf(s) <= V) */
function letter(d: vec4, c: number): vec4 {
  const r = floor(d.y / 256)
  let s = 0
  let lo = 0
  let hi = d.y
  for (const k of range(4)) {
    const i = s + (k < 0.5 ? 8 : k < 1.5 ? 4 : k < 2.5 ? 2 : 1)
    const v = r * Q.at(vec2(i, c)).x
    const ok = v - d.x < 0.5
    s = ok ? i : s
    lo = ok ? v : lo
    hi = ok ? hi : min(hi, v)
  }
  return renorm(d.x - lo, hi - lo, d.z, s)
}
/** k (0..19) equally likely bits */
function raw(d: vec4, k: number): vec4 {
  const p = POWof(k)
  const r = floor(d.y / p)
  const m = p - 1
  let q = floor(d.x / r)
  q = q * r - d.x > 0.5 ? q - 1 : q
  q = (q + 1) * r - d.x < 0.5 ? q + 1 : q
  q = min(q, m)
  return renorm(d.x - q * r, q < m - 0.5 ? r : d.y - q * r, d.z, q)
}

// zigzag index -> raster position; the 8-point inverse DCT basis, [x * 8 + u]
const ZZ = table([0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63], 'int')
/** quantiser t of the picture's tables (0-63 luma, 64-127 chroma, raster order) */
function quant(t: number): number {
  const w = signed(at(T0 + floor(t / 3)))
  const r = mod(t, 3)
  return mod(floor(w / (r < 0.5 ? 65536 : r < 1.5 ? 256 : 1)), 256)
}
const C8 = table([0.35355, 0.49039, 0.46194, 0.41573, 0.35355, 0.27779, 0.19134, 0.09755, 0.35355, 0.41573, 0.19134, -0.09755, -0.35355, -0.49039, -0.46194, -0.27779, 0.35355, 0.27779, -0.19134, -0.49039, -0.35355, 0.09755, 0.46194, 0.41573, 0.35355, 0.09755, -0.46194, -0.27779, 0.35355, 0.41573, -0.19134, -0.49039, 0.35355, -0.09755, -0.46194, 0.27779, 0.35355, -0.41573, -0.19134, 0.49039, 0.35355, -0.27779, -0.19134, 0.49039, -0.35355, -0.09755, 0.46194, -0.41573, 0.35355, -0.41573, 0.19134, 0.09755, -0.35355, 0.49039, -0.46194, 0.27779, 0.35355, -0.49039, 0.46194, -0.41573, 0.35355, -0.27779, 0.19134, -0.09755])

// --- decoding, once every word is in -------------------------------------------------------------------------------
const going = () => ctl.at(vec2(1, 14)).x > 0.5 && !done()
// the slice decoders, a column each. Row 0: x V, y R, z the next bit, w blocks decoded; row 1: x the last block's mode,
// y its entry count, z 1 once started. A run decodes the slice's next block b into rows 2 + 4g .. 2 + 4g + 3,
// g = b mod REP: its 16 numbers, as P keeps them. REP runs a frame, so a luma slice's 160 blocks take 160 / REP frames. Cg blocks have no mode letter (they use their Co block's mode); a block's mpm is
// the mode of the block to its left in the same tile, else DC.
const REP = 2
const D: Buffer = buffer({ size: [192, 2 + 4 * REP], float: 32, filter: 'nearest', repeat: REP }, q => {
  if (!going()) return done() ? D.at(q.cell) : vec4(0)
  const sl = q.cell.x
  const row = q.cell.y
  const old = D.at(q.cell)
  const s0 = D.at(vec2(sl, 0))
  const s1 = D.at(vec2(sl, 1))
  const fresh = s1.z < 0.5
  const b = fresh ? 0 : s0.w
  if (b > (sl < 95.5 ? 159.5 : 79.5)) return old
  const grp = mod(b, REP)
  const t = row - 2 - 4 * grp
  if (row > 1.5 && (t < -0.5 || t > 3.5)) return old
  const plane = sl < 95.5 ? 0 : sl < 143.5 ? 1 : 2
  const coded = plane < 1.5
  const mpm = fresh || imod(b, plane < 0.5 ? 40 : 20) < 0.5 ? 0 : s1.x
  const p0 = signed(at(1024 + sl))
  const d0 = fresh ? vec4(bitsAt(p0, 24), 16777215, p0 + 24, 0) : vec4(s0.x, s0.y, s0.z, 0)
  const ml = letter(d0, plane)
  const mode = coded ? (ml.w < 0.5 ? mpm : ml.w - 1 < mpm - 0.5 ? ml.w - 1 : ml.w) : 0
  const dl = letter(coded ? ml : d0, 2 + plane)
  const dr = raw(dl, EXTof(dl.w))
  const dv = BASEof(dl.w) + dr.w
  const dc = mod(dv, 2) > 0.5 ? (dv + 1) / 2 : 0 - dv / 2
  const nl = letter(dr, 5 + plane * 4 + nBk(fresh ? 0 : s1.y))
  const n = nl.w
  let d = nl
  let last = 0
  let res = vec4(t < 0.5 ? 1 + mode + 8 * n + 128 * (dc + 4096) : 0, 0, 0, 0)
  for (const j of range(15)) {
    const on = j < n - 0.5
    const rem = n - j
    const rl = letter(d, 17 + plane * 18 + runBk(last) * 3 + remBk(rem))
    const ll = letter(rl, 71 + plane * 24 + posBk(min(last + BASEof(rl.w) + 1, 63)) * 3 + remBk(rem))
    const eL = EXTof(ll.w)
    const u = raw(ll, EXTof(rl.w) + eL + 1)
    const rest = floor(u.w / 2)
    const pw = POWof(eL)
    const a = BASEof(ll.w) + mod(rest, pw)
    const k = last + BASEof(rl.w) + floor(rest / pw) + 1
    const lev = mod(u.w, 2) > 0.5 ? 0 - a - 1 : a + 1
    const e = on ? k * 16384 + lev + 8192 : 0
    const ch = j + 1 - 4 * t
    res = vec4(abs(ch) < 0.5 ? e : res.x, abs(ch - 1) < 0.5 ? e : res.y, abs(ch - 2) < 0.5 ? e : res.z, abs(ch - 3) < 0.5 ? e : res.w)
    d = on ? u : d
    last = on ? k : last
  }
  if (row < 0.5) return vec4(d.x, d.y, d.z, b + 1)
  if (row < 1.5) return vec4(mode, n, 1, 1)
  return res
})
// every block's 16 numbers, per slice (y) and block b (x = 4b .. 4b + 3): [0] 1 + mode + 8 n + 128 (DC + 4096), 0
// until decoded; [1 + j] entry j's zigzag index * 16384 + its level + 8192, 0 past the last
const P: Buffer = buffer({ size: [640, 192], float: 32, filter: 'nearest' }, q => {
  const old = P.at(q.cell)
  if (!going()) return done() ? old : vec4(0)
  const b = floor(q.cell.x / 4)
  if (P.at(vec2(b * 4, q.cell.y)).x > 0.5) return old
  // D's rows hold the last REP blocks it decoded
  const nb = D.at(vec2(q.cell.y, 0)).w
  const fresh = b < nb - 0.5 && b > nb - REP - 0.5
  return fresh ? D.at(vec2(q.cell.y, 2 + 4 * mod(b, REP) + q.cell.x - 4 * b)) : old
})
const S = () => signed(at(9)) / 4096
const decoding = () => stageNow() > REC + 0.5 && stageNow() < REC + BANDS + 0.5
// deblocking trails the painting by a frame: window w = stage - REC - 2 covers picture rows 64w - 4 .. 64w + 59, which
// hold whole edge neighbourhoods (4 rows each side of every 8th row), so a window needs no rows from outside itself
const deblocking = () => stageNow() > REC + 1.5 && !done()
const win = () => stageNow() - REC - 2

// --- the rebuild: 48 tiles in lockstep, a block diagonal (tx + 2 ty) of each a step ------------------------------------
// Slots: 0-383 luma (tile * 8 + ty: tiles 4 across, 12 down, of 40 x 8 blocks), 384-575 Co and 576-767 Cg (tile * 4 + ty,
// tiles of 20 x 4 blocks). Slot g at step t -> x block, y block row, z plane (0 Y, 1 Co, 2 Cg), w 1 if it has a block.
function slotBlock(g: number, t: number): vec4 {
  const luma = g < 383.5
  const h = luma ? g : mod(g - 384, 192)
  const per = luma ? 8 : 4
  const tw = luma ? 40 : 20
  const tile = floor(h / per)
  const ty = h - tile * per
  const tx = t - 2 * ty
  const plane = luma ? 0 : g < 575.5 ? 1 : 2
  return vec4(mod(tile, 4) * tw + tx, floor(tile / 4) * per + ty, plane, tx > -0.5 && tx < tw - 0.5 ? 1 : 0)
}
const sliceOf = (b: vec4) => (b.z < 0.5 ? b.y : b.z < 1.5 ? 96 + b.y : 144 + b.y)
// this step's blocks' entries: slot g's entry i at x = (g mod 64) * 16 + i, y = floor(g / 64); x the zigzag index, y the
// dequantised level (entry 0 the DC; past the last, 0); entry 0's z the block's mode (a Cg block's: its Co block's)
const K: Buffer = buffer({ size: [1024, 12], float: 32, filter: 'nearest' }, q => {
  if (!rebuilding()) return vec4(0)
  const g = q.cell.y * 64 + floor(q.cell.x / 16)
  const sb = slotBlock(g, rstep())
  if (sb.w < 0.5) return vec4(0)
  const i = mod(q.cell.x, 16)
  const h = P.at(vec2(sb.x * 4, sliceOf(sb))).x
  const f = P.at(vec2(sb.x * 4 + floor(i / 4), sliceOf(sb)))
  const c = mod(i, 4)
  const ev = c < 0.5 ? f.x : c < 1.5 ? f.y : c < 2.5 ? f.z : f.w
  const k = i > 0.5 && ev > 0.5 ? floor(ev / 16384) : 0
  const lev = i < 0.5 ? floor((h - 1) / 128) - 4096 : ev > 0.5 ? mod(ev, 16384) - 8192 : 0
  const mode = i < 0.5 ? mod(P.at(vec2(sb.x * 4, sb.z < 0.5 ? sb.y : 96 + sb.y)).x - 1, 8) : 0
  return vec4(k, lev * quant((sb.z > 0.5 ? 64 : 0) + signed(ZZ.at(k))), mode, 1)
})
/** a decoded sample of a plane at picture position (px, py), 0..255 */
function pix(plane: number, px: number, py: number): number {
  const c = rec.at(vec2(px, CH - 1 - py))
  return floor((plane < 0.5 ? c.r : plane < 1.5 ? c.g : c.b) * 255 + 0.5)
}
/** mode m's prediction of pixel (x, y) of block (bx, by), from the decoded row above (+ above-right), the column to the
 * left and the corner, inside the tile; integer arithmetic, as intra-svg.mjs */
function predict(plane: number, bx: number, by: number, m: number, x: number, y: number): number {
  const tw = plane < 0.5 ? 40 : 20
  const th = plane < 0.5 ? 8 : 4
  const x0 = bx * 8
  const y0 = by * 8
  const hasT = mod(by, th) > 0.5 ? 1 : 0
  const hasL = mod(bx, tw) > 0.5 ? 1 : 0
  const hasTR = hasT > 0.5 && mod(bx, tw) < tw - 1.5 ? 1 : 0
  const t0 = hasL > 0.5 ? pix(plane, x0 - 1, y0) : 128
  const T = (i: number) => (hasT > 0.5 ? pix(plane, x0 + (hasTR > 0.5 ? i : min(i, 7)), y0 - 1) : t0)
  const l0 = hasT > 0.5 ? pix(plane, x0, y0 - 1) : 128
  const L = (i: number) => (hasL > 0.5 ? pix(plane, x0 - 1, y0 + i) : l0)
  const c = hasT + hasL > 1.5 ? pix(plane, x0 - 1, y0 - 1) : hasT > 0.5 ? l0 : hasL > 0.5 ? t0 : 128
  const tx = T(x)
  const ly = L(y)
  let sum = 8
  for (const i of range(8)) sum = sum + T(i) + L(i)
  const dc = floor(sum / 16)
  const base = tx + ly - c
  const pl = abs(base - ly)
  const pt = abs(base - tx)
  const pc = abs(base - c)
  const paeth = pl <= pt && pl <= pc ? ly : pt <= pc ? tx : c
  const smo = floor(((8 - y) * tx + (y + 1) * L(7) + (8 - x) * ly + (x + 1) * T(7) + 9) / 18)
  const s5 = x + y
  const d45 = floor((T(min(s5, 15)) + 2 * T(min(s5 + 1, 15)) + T(min(s5 + 2, 15)) + 2) / 4)
  const E = (k: number) => (k < -0.5 ? L(0 - k - 1) : k < 0.5 ? c : T(k - 1))
  const d = x - y
  const d135 = floor((E(clamp(d - 1, -8, 8)) + 2 * E(clamp(d, -8, 8)) + E(clamp(d + 1, -8, 8)) + 2) / 4)
  const grad = clamp(ly + tx - c, 0, 255)
  return m < 0.5 ? dc : m < 1.5 ? tx : m < 2.5 ? ly : m < 3.5 ? paeth : m < 4.5 ? smo : m < 5.5 ? d45 : m < 6.5 ? d135 : grad
}
// this step's blocks, decoded: slot g's pixel (xi, yi) at x = (g mod 128) * 8 + xi, y = floor(g / 128) * 8 + yi
const W: Buffer = buffer({ size: [1024, 48], float: 16, filter: 'nearest' }, q => {
  if (!rebuilding()) return vec4(0)
  const g = floor(q.cell.y / 8) * 128 + floor(q.cell.x / 8)
  const xi = mod(q.cell.x, 8)
  const yi = mod(q.cell.y, 8)
  const sb = slotBlock(g, rstep())
  if (sb.w < 0.5) return vec4(0)
  let r = 0
  for (const i of range(16)) {
    const e = K.at(vec2(mod(g, 64) * 16 + i, floor(g / 64)))
    const pos = signed(ZZ.at(e.x))
    r = r + e.y * C8.at(xi * 8 + mod(pos, 8)) * C8.at(yi * 8 + floor(pos / 8))
  }
  const mode = K.at(vec2(mod(g, 64) * 16, floor(g / 64))).z
  return vec4(clamp(floor(r * S() + predict(sb.z, sb.x, sb.y, mode, xi, yi) + 0.5), 0, 255), 0, 0, 1)
})
const wAt = (g: number, xi: number, yi: number) => W.at(vec2(mod(g, 128) * 8 + xi, floor(g / 128) * 8 + yi)).x / 255
// the decoded planes, kept: r luma (1280 x 768), g Co and b Cg (640 x 384, at x < 640, picture row < 384); row py at
// y = CH - 1 - py. Each step copies in the blocks W just decoded.
const rec: Buffer = buffer({ size: [1280, 768], filter: 'nearest' }, q => {
  const old = rec.at(q.cell)
  if (stageNow() < 0.5) return vec4(0)
  if (!rebuilding()) return old
  const t = rstep()
  const px = q.cell.x
  const py = CH - 1 - q.cell.y
  const bx = floor(px / 8)
  const by = floor(py / 8)
  const xi = px - bx * 8
  const yi = py - by * 8
  const lt = mod(bx, 40) + 2 * mod(by, 8)
  const yv = lt > t - 0.5 && lt < t + 0.5 ? wAt((floor(by / 8) * 4 + floor(bx / 40)) * 8 + mod(by, 8), xi, yi) : old.r
  const ct = mod(bx, 20) + 2 * mod(by, 4)
  const isC = px < 639.5 && py < 383.5 && ct > t - 0.5 && ct < t + 0.5
  const gc = (floor(by / 4) * 4 + floor(bx / 20)) * 4 + mod(by, 4)
  return vec4(yv, isC ? wAt(384 + gc, xi, yi) : old.g, isC ? wAt(576 + gc, xi, yi) : old.b, 1)
})
const chromaAt = (x: number, y: number) => rec.at(vec2(x, CH - 1 - y)).gb * 255
// --- deblocking, a window a frame -------------------------------------------------------------------------------------
// The 8x8 blocks show as steps at their edges. Across each edge (luma every 8 pixels, chroma every 16), a step smaller
// than a real edge is ramped out over 4 pixels each side where both blocks are flat, or eased at the two edge pixels
// where they are not. Thresholds follow the quantiser (a luma DC step is 2 * s levels). `dbH` does the columns of
// this frame's window (read from `pic` as last frame left it, still raw there), `dbV` the rows, and `pic` keeps it.
const ycc = (c: vec3) => vec3((c.r + 2 * c.g + c.b) * 63.75, (c.r - c.b) * 127.5, (2 * c.g - c.r - c.b) * 63.75)
function deb(p3: number, p2: number, p1: number, p0: number, q0: number, q1: number, q2: number, q3: number, k: number, a: number, bt: number, tc: number): number {
  const self = k < -3.5 ? p3 : k < -2.5 ? p2 : k < -1.5 ? p1 : k < -0.5 ? p0 : k < 0.5 ? q0 : k < 1.5 ? q1 : k < 2.5 ? q2 : q3
  const d = q0 - p0
  const flat = max(max(max(abs(p2 - p3), abs(p1 - p2)), max(abs(p0 - p1), abs(q1 - q0))), max(abs(q2 - q1), abs(q3 - q2)))
  const off = k < 0 ? (2 * (k + 4) + 1) / 16 : 0 - (2 * (3 - k) + 1) / 16
  const dl = clamp((d * 4 + p1 - q1 + 4) / 8, 0 - tc, tc)
  const weak = k > -1.5 && k < 0.5 ? (k < -0.5 ? p0 + dl : q0 - dl) : self
  return abs(d) >= a ? self : flat < bt ? self + d * off : weak
}
// one line of 8 YCoCg pixels across an edge, filtered at offset k (-4..3); chroma only on its own (16 px) edges
function debLine(t0: vec3, t1: vec3, t2: vec3, t3: vec3, t4: vec3, t5: vec3, t6: vec3, t7: vec3, k: number, chroma: number): vec3 {
  const ql = S() * quant(0) / 8
  const qc = S() * quant(64) / 8
  const y = deb(t0.x, t1.x, t2.x, t3.x, t4.x, t5.x, t6.x, t7.x, k, ql * 4, ql * 1.5, ql)
  const self = k < -3.5 ? t0 : k < -2.5 ? t1 : k < -1.5 ? t2 : k < -0.5 ? t3 : k < 0.5 ? t4 : k < 1.5 ? t5 : k < 2.5 ? t6 : t7
  const o = chroma > 0.5 ? deb(t0.y, t1.y, t2.y, t3.y, t4.y, t5.y, t6.y, t7.y, k, qc * 4, qc * 1.5, qc) : self.y
  const g = chroma > 0.5 ? deb(t0.z, t1.z, t2.z, t3.z, t4.z, t5.z, t6.z, t7.z, k, qc * 4, qc * 1.5, qc) : self.z
  return vec3(y, o, g)
}
// window row wr (0 at the top, y = 63 - cell.y) is picture row 64w - 4 + wr, at pic y = CH - 1 - that
const dbH: Buffer = buffer({ size: [1280, 64], float: 16, filter: 'nearest' }, q => {
  if (!deblocking()) return vec4(0)
  const py = CH - 1 - clamp(win() * 64 - 4 + 63 - q.cell.y, 0, PH - 1)
  const m = mod(q.cell.x, 8)
  const k = m < 3.5 ? m : m - 8
  const e = q.cell.x - k
  const tap = (i: number) => ycc(pic.at(vec2(clamp(e + i, 0, 1279), py)).rgb)
  if (e < 0.5 || e > 1279.5) return vec4(ycc(pic.at(vec2(q.cell.x, py)).rgb), 1)
  return vec4(debLine(tap(-4), tap(-3), tap(-2), tap(-1), tap(0), tap(1), tap(2), tap(3), k, mod(e, 16) < 0.5 ? 1 : 0), 1)
})
const dbV: Buffer = buffer({ size: [1280, 64], filter: 'nearest' }, q => {
  if (!deblocking()) return vec4(0)
  const wr = 63 - q.cell.y
  const r = win() * 64 - 4 + wr
  const m = mod(r, 8)
  const k = m < 3.5 ? m : m - 8
  const e = r - k
  // the edge's 8 rows, all inside this window
  const tap = (i: number) => dbH.at(vec2(q.cell.x, q.cell.y + k - i)).xyz
  const c = e < 0.5 || e > PH - 0.5 ? dbH.at(q.cell).xyz : debLine(tap(-4), tap(-3), tap(-2), tap(-1), tap(0), tap(1), tap(2), tap(3), k, mod(e, 16) < 0.5 ? 1 : 0)
  return vec4(clamp(vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z) / 255, 0, 1), 1)
})

// the picture, painted a band a frame and kept (alpha 1 where painted)
const pic: Buffer = buffer({ size: [1280, 768], filter: 'linear', wrap: 'clamp' }, q => {
  const old = pic.at(q.cell)
  if (stageNow() < 0.5) return vec4(0)
  if (done()) return old
  // last frame's band, deblocked (its window ends 4 rows above this frame's band)
  const wr = CH - 1 - q.cell.y - (win() * 64 - 4)
  if (deblocking() && wr > -0.5 && wr < 63.5) return vec4(dbV.at(vec2(q.cell.x, 63 - wr)).rgb, 1)
  if (!decoding()) return old
  const t = band()
  const rr = CH - 1 - q.cell.y - t * 64
  if (rr < -0.5 || rr > 63.5) return old
  const py = CH - 1 - q.cell.y
  const yv = floor(rec.at(q.cell).r * 255 + 0.5)
  // chroma sits between luma pixels: blend the four nearest
  const cx = clamp((q.cell.x + 0.5) / 2 - 0.5, 0, 639)
  const cy = clamp((py + 0.5) / 2 - 0.5, 0, 383)
  const x0 = floor(cx)
  const y0 = floor(cy)
  const x1 = min(x0 + 1, 639)
  const y1 = min(y0 + 1, 383)
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
  passes: [acc, ctl, Q, D, P, K, W, rec, dbH, dbV, pic, sway, picture(q => {
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
    // debug strip: words seen (green, top), then the stage: blocks placing (yellow), rebuild + bands (white, growing)
    const r = ctl.at(vec2(1, 14))
    const st = stageNow()
    const top = q.uv.y > 0.95
    const bar = top ? q.uv.x < r.y / WORDS : q.uv.x < (st > 0.5 ? st / (REC + BANDS + 2) : r.x > 0.5 ? 0.05 : 0)
    return vec4(bar ? (top ? vec3(0.1, 0.8, 0.2) : st > 0.5 ? vec3(1) : vec3(1, 0.85, 0.1)) : vec3(0.15), 1)
  })],
})
