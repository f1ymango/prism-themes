// ka2-enc.mjs: a reference frame + packed motion -> one Svg whose keyframe is coded as KA2, played by hooks/live-key.ts.
// KA2 = KA1's transport and range coder with AV1's intra tools: 16x16 superblocks (one 16x16 block or four 8x8),
// uncapped coefficients, chroma-from-luma, 16 luma angles with +-2 deltas, an integer inverse DCT, then the deblock
// and a luma CDEF on the decoded picture. Every step is integer arithmetic, so the shader decodes it bit for bit.
//   node ka2-enc.mjs <ref.rgb> <refW> <refH> <pack.json> <out.svg> [preview.png] [step ms=50] [gap s=20]
//   env QTAB=<[luma64, chroma64] json> quantisers; FIXS=<s> skip the s search (quick runs); REF=<file> write the
//   decoder's planes and pictures for the shader simulator; WORDS=<file> write the words as json.
// Words (16 x 8 SMIL cells, 110 moments, 24 bits each):
//   0..15      header: 0 'PRL', 1-3 motion scales * 65536, 4 loop ms, 5 picture aspect * 1e6, 6-7 motion frame W/H,
//              8 'KA2' (0x4B4132), 9 quantiser scale s * 4096 (a whole number), 10 the stream's first word,
//              11 'THB' when the loading preview (thumb.mjs: words 1152..1211) is present
//   16..1023   motion (as live.ts), or with motion v2 (mv2.mjs: 12 'MV2', 13 layout, 14 block words MW, 15 moving
//              nodes) its block: word i at 16 + i, from i = 1008 on at WORDS - MW + i (the stream then ends at WORDS - (MW - 1008))
//   1024..1119 bit offset of each slice in the stream: Y superblock rows 0-47, Co 48-71, Cg 72-95
//   1120..1151 CDEF: 1120-1121 eight presets, 6 bits each (pri * 4 + sec index, sec 0 1 2 4), high first; 1122-1151
//              each 64x64 unit's preset (20 x 12 units, row by row, 3 bits each, 8 a word, high first)
//   1216..1258 quantisers (luma 64 then chroma 64, raster order, a byte each, 3 a word, high byte first)
//   1259..1385 symbol tables: byte offset of context c's table (12 bits, 2 a word, high first), c = 0..252
//   1386..     the tables: context c's are bytes off(c)..off(c+1)-1, the cumulative frequencies (of 256) of letters
//              1..last (letter 0 starts at 0; letters past last are never coded), 3 bytes a word
//   word 10..  the stream, MSB first
// Range coder (as KA1): V (24 bits of the stream) and R (2^24 - 1) to start; R stays in [2^23, 2^24). A letter: r =
// floor(R / 256), the letter is the largest s with r * cdf(s) <= V; V -= r * cdf(s), R = r * cdf(s + 1) (R itself for
// the last letter) - r * cdf(s). k raw bits (k <= 23): r = floor(R / 2^k), q = min(floor(V / r), 2^k - 1); V -= q * r,
// R = r (R - q * r for the top value).
// Picture: 1280 x 760 padded to 768, YCoCg, chroma 640 x 384. Superblocks of 16 x 16 (luma 80 x 48, chroma 40 x 24);
// tiles of 20 x 4 (luma) and 10 x 2 (chroma) superblocks, which prediction never crosses. A slice is a superblock row.
// Per superblock: partition letter (Y, Co; 0 one 16x16, 1 four 8x8 in z-order), then each block: mode letter (Y, Co;
// Cg uses Co's), delta letter (Y directional modes), alpha letter (chroma mode 8 = CfL), DC class + low bits, n letter
// (15 = 15 or more: then 6 raw bits for 8x8, 8 for 16x16, hold n - 15), n x (run class, level class, one raw group).
// Coefficients: c16 = floor((level * q * s4096 + 128) / 256) (1/16ths); rows t = floor((sum c16 * B + 2048) / 4096), then
// columns r = sum t * B, pixel = clamp(floor((r + 32768) / 65536) + prediction, 0, 255); B = the integer basis (4096
// scale): B8 = round(2048 cos), 1448 at u = 0; B16 = round(4096 sqrt(1/8) cos), 1024 at u = 0.
// Angles: a = 3.75 n degrees; T64[n] = round(64 tan(3.75 n)), n 0..23, gives every 64 cot and 64 tan used.
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { thumbWords } from './thumb.mjs'

const [, , refPath, rws, rhs, packPath, outPath, previewPath, stepArg = '50', gapArg = '20'] = process.argv
const RW = +rws, RH = +rhs
const ref = readFileSync(refPath)
const pack = JSON.parse(readFileSync(packPath, 'utf8'))
// motion v2 (mv2.mjs): its block fills words 16..1023, then takes words from the end of the stream
const V2 = pack.v === 2
const CW = 1280, CH = 768, PH = 760
const CELLS = 128, MOMENTS = 110, WORDS = CELLS * MOMENTS, T0 = 1216, CT0 = 1259, NCTX = 252, CB0 = CT0 + Math.ceil((NCTX + 1) / 2)
const TILE = [[40, 8], [20, 4]] // luma, chroma (blocks)
const CFL = process.env.CFL !== '0'
// chroma-from-luma: alpha = A8[letter] / 8; the prediction is DC + floor((a * AC + 16) / 32), AC = 2x2 luma sum - its block mean
const A8 = (process.env.A8 ?? '-16,-12,-8,-6,-4,-3,-2,-1,1,2,3,4,6,8,12,16').split(',').map(Number)
const CFL_AC = new Int32Array(64); let CFL_A = 0, LUMA = null
function cflAC(bx, by) {
  let sum = 0
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const i = (by * 16 + 2 * y) * 1280 + bx * 16 + 2 * x
    const v = LUMA[i] + LUMA[i + 1] + LUMA[i + 1280] + LUMA[i + 1281]
    CFL_AC[y * 8 + x] = v; sum += v
  }
  const m = Math.floor((sum + 32) / 64)
  let e = 0; for (let i = 0; i < 64; i++) { CFL_AC[i] -= m; e += CFL_AC[i] ** 2 }
  return e
}
const SWORDS = WORDS - (V2 ? Math.max(0, pack.words.length - 1008) : 0) // the stream ends here
const RDO_L = +(process.env.RDO_L ?? 0.15), WEIGHT = [1, 8 / 3, 4]
// 16x16 luma superblocks (80 x 48; a tile is 20 x 4 of them). PART=0: always four 8x8 in z-order, no partition letter
const PART = process.env.PART !== '0'
// CAP: the most AC entries a block keeps (15 as KA1); above 15, n letter 15 means "15 or more" and raw bits follow
// holding n - 15 (6 for 8x8, 8 for 16x16)
const CAP = +(process.env.CAP ?? 15), ESC = CAP > 15
const escBits = (n, k) => (ESC && n >= 15 ? k : 0)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
function resize(src, sw, sh, dw, dh, ch) { // area average (down only)
  const out = new Float32Array(dw * dh * ch)
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const x0 = (x * sw) / dw, x1 = ((x + 1) * sw) / dw, y0 = (y * sh) / dh, y1 = ((y + 1) * sh) / dh
    const acc = new Float64Array(ch); let wsum = 0
    for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
      const w = (Math.min(xx + 1, x1) - Math.max(xx, x0)) * (Math.min(yy + 1, y1) - Math.max(yy, y0)); if (w <= 0) continue
      for (let c = 0; c < ch; c++) acc[c] += src[(yy * sw + xx) * ch + c] * w; wsum += w
    }
    for (let c = 0; c < ch; c++) out[(y * dw + x) * ch + c] = acc[c] / wsum
  }
  return out
}
const ZZ = (() => { const z = []; for (let s = 0; s < 15; s++) for (let i = 0; i <= s; i++) { const r = s % 2 ? i : s - i, c = s - r; if (r < 8 && c < 8) z.push(r * 8 + c) } return z })()
const QL = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99]
const QC = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, ...new Array(32).fill(99)]
const [TL, TC] = process.env.QTAB ? JSON.parse(readFileSync(process.env.QTAB, 'utf8')) : [QL, QC]
// the inverse DCT basis exactly as the shader's table holds it (5 decimals), [x * 8 + u]
const C = new Float64Array(64)
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) C[x * 8 + u] = +(Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u ? 0.5 : 0.5 * Math.SQRT1_2)).toFixed(5)
const tmp = new Float64Array(64)
function fdct(b, out) {
  for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) { let a = 0; for (let x = 0; x < 8; x++) a += b[y * 8 + x] * C[x * 8 + u]; tmp[y * 8 + u] = a }
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) { let a = 0; for (let y = 0; y < 8; y++) a += tmp[y * 8 + u] * C[y * 8 + v]; out[v * 8 + u] = a }
}
function idctAt(dq, x, y) { let a = 0; for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) if (dq[v * 8 + u]) a += dq[v * 8 + u] * C[x * 8 + u] * C[y * 8 + v]; return a }
// --- the integer inverse DCT (the shader's; see the header) ----------------------------------------------------------
let S4096 = 0
const CT8 = Array.from({ length: 9 }, (_, m) => Math.round(2048 * Math.cos((m * Math.PI) / 16)))
const CT16 = Array.from({ length: 17 }, (_, m) => Math.round(((4096 * Math.SQRT1_2) / 2) * Math.cos((m * Math.PI) / 32)))
function basis(N, x, u) {
  if (!u) return N === 8 ? 1448 : 1024
  const t = N === 8 ? CT8 : CT16, m = ((2 * x + 1) * u) % (4 * N)
  return m <= N ? t[m] : m <= 2 * N ? -t[2 * N - m] : m <= 3 * N ? -t[m - 2 * N] : t[4 * N - m]
}
const BI8 = Int32Array.from({ length: 64 }, (_, i) => basis(8, i >> 3, i & 7))
const BI16 = Int32Array.from({ length: 256 }, (_, i) => basis(16, i >> 4, i & 15))
const c16of = (lev, q) => Math.floor((lev * q * S4096 + 128) / 256)
const BIG = 2 ** 31
const rc16 = new Int32Array(256), rt16 = new Int32Array(256)
/** levels (zigzag lv, order zz) with quantisers q[raster] -> out[y * N + x] = clamp(residual + pred[y * N + x]) */
function recon(lv, zz, q, N, pred, out) {
  const B = N === 8 ? BI8 : BI16, NN = N * N
  rc16.fill(0, 0, NN)
  for (let k = 0; k < NN; k++) if (lv[k]) rc16[zz[k]] = c16of(lv[k], q[zz[k]])
  for (let v = 0; v < N; v++) for (let x = 0; x < N; x++) {
    let a = 0; for (let u = 0; u < N; u++) a += rc16[v * N + u] * B[x * N + u]
    if (Math.abs(a) >= BIG) throw new Error('idct row overflow')
    rt16[v * N + x] = Math.floor((a + 2048) / 4096)
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let a = 0; for (let v = 0; v < N; v++) a += rt16[v * N + x] * B[y * N + v]
    if (Math.abs(a + 32768) >= BIG) throw new Error('idct column overflow')
    out[y * N + x] = clamp(Math.floor((a + 32768) / 65536) + pred[y * N + x], 0, 255)
  }
}

// --- planes ---------------------------------------------------------------------------------------------------------
const pic = resize(ref, RW, RH, CW, PH, 3)
const Y = new Float32Array(CW * CH), Co = new Float32Array(CW * CH), Cg = new Float32Array(CW * CH)
let mean = [0, 0, 0]
for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
  const s = (Math.min(y, PH - 1) * CW + x) * 3, i = y * CW + x, r = pic[s], g = pic[s + 1], b = pic[s + 2]
  if (y < PH) { mean[0] += r; mean[1] += g; mean[2] += b }
  Y[i] = (r + 2 * g + b) / 4; Co[i] = (r - b) / 2 + 128; Cg[i] = (-r + 2 * g - b) / 4 + 128
}
mean = mean.map(v => Math.round(v / (CW * PH)))
const CoH = resize(Co, CW, CH, CW / 2, CH / 2, 1), CgH = resize(Cg, CW, CH, CW / 2, CH / 2, 1)

// --- prediction (integer; the shader does the same) ------------------------------------------------------------------
const T = new Int32Array(16), L = new Int32Array(8)
/** fills T (above, 16 incl. above-right), L (left); returns the corner. rec: the plane's reconstruction (w wide) */
function neighbours(rec, w, bx, by, tw, th, noTR = false) {
  const x0 = bx * 8, y0 = by * 8, hasT = by % th > 0, hasL = bx % tw > 0, hasTR = hasT && bx % tw < tw - 1 && !noTR
  const t0 = hasT ? -1 : hasL ? rec[y0 * w + x0 - 1] : 128
  for (let i = 0; i < 16; i++) T[i] = hasT ? rec[(y0 - 1) * w + x0 + (hasTR ? i : Math.min(i, 7))] : t0
  for (let i = 0; i < 8; i++) L[i] = hasL ? rec[(y0 + i) * w + x0 - 1] : hasT ? T[0] : 128
  return hasT && hasL ? rec[(y0 - 1) * w + x0 - 1] : hasT ? T[0] : hasL ? L[0] : 128
}
// directional luma modes 9..16 (DIR=0: off): angle a (90 = from above, 180 = from the left); each pixel is projected
// along a onto the row above (T, -1 = the corner) or else the column to the left (L), and the two nearest are mixed in
// 1/64ths: pred = (v0 * (64 - f) + v1 * f + 32) >> 6, integers only. cot64 = round(64 cot a), tan64 = round(64 tan a)
const DIR = process.env.DIR !== '0'
const ANG = [56.25, 67.5, 78.75, 101.25, 112.5, 146.25, 157.5, 168.75]
// angle deltas (DELTA=0: off): every directional luma mode (1 V, 2 H, 9..16) takes a delta letter (ctx 251), d = -2..2
// steps of 3.75 degrees; past 180 the ray only meets the left column (L clamped to N - 1). CUR_D: the delta in use
const DELTA = process.env.DELTA !== '0'
const isDir = m => m === 1 || m === 2 || m > 8, CDELTA = 251
let CUR_D = 0
const baseAng = m => (m === 1 ? 90 : m === 2 ? 180 : ANG[m - 9])
// angle n (a = 3.75 n degrees): every 64 cot and 64 tan from T64 (n 0..23), so the shader holds 24 numbers
const T64 = Array.from({ length: 24 }, (_, n) => Math.round(64 * Math.tan((3.75 * n * Math.PI) / 180)))
const cot64 = n => (n === 48 ? -1e9 : n < 24 ? T64[24 - n] : n === 24 ? 0 : n < 48 ? -T64[n - 24] : T64[72 - n])
const tan64 = n => (n === 24 ? 1e9 : n < 24 ? T64[n] : n < 48 ? -T64[48 - n] : n === 48 ? 0 : T64[n - 48])
const DA = [], COT64 = [], TAN64 = []
for (let m = 0; m < 17; m++) for (let d = -2; d <= 2; d++) {
  const n = isDir(m) ? Math.round(baseAng(m) / 3.75) + d : 24, k = m * 5 + d + 2
  DA[k] = 3.75 * n; COT64[k] = cot64(n); TAN64[k] = tan64(n)
}
const LUMA_MODES = DIR ? [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16] : [0, 1, 2, 3, 4, 5, 6, 7]
function dirPred(T, L, c, N, x, y, m) {
  const k = m * 5 + CUR_D + 2, xr = x * 64 + (y + 1) * COT64[k]
  if (DA[k] < 180 && xr >= -64) {
    const i = Math.floor(xr / 64), f = xr - 64 * i, t = j => (j < 0 ? c : T[Math.min(j, 2 * N - 1)])
    return (t(i) * (64 - f) + t(i + 1) * f + 32) >> 6
  }
  const yr = y * 64 + (x + 1) * TAN64[k], j = Math.floor(yr / 64), f = yr - 64 * j, l = i => (i < 0 ? c : L[Math.min(i, N - 1)])
  return (l(j) * (64 - f) + l(j + 1) * f + 32) >> 6
}
function predictAt(m, c, x, y) {
  if (m > 8 || (CUR_D && (m === 1 || m === 2))) return dirPred(T, L, c, 8, x, y, m)
  switch (m) {
    case 0: { let a = 8; for (let i = 0; i < 8; i++) a += T[i] + L[i]; return Math.floor(a / 16) }
    case 1: return T[x]
    case 2: return L[y]
    case 3: { const base = T[x] + L[y] - c, pl = Math.abs(base - L[y]), pt = Math.abs(base - T[x]), pc = Math.abs(base - c)
      return pl <= pt && pl <= pc ? L[y] : pt <= pc ? T[x] : c }
    case 4: return Math.floor(((8 - y) * T[x] + (y + 1) * L[7] + (8 - x) * L[y] + (x + 1) * T[7] + 9) / 18)
    case 5: { const i = x + y; return Math.floor((T[Math.min(i, 15)] + 2 * T[Math.min(i + 1, 15)] + T[Math.min(i + 2, 15)] + 2) / 4) }
    case 6: { const d = x - y, e = k => (k < 0 ? L[-k - 1] : k === 0 ? c : T[k - 1])
      return Math.floor((e(clamp(d - 1, -8, 8)) + 2 * e(clamp(d, -8, 8)) + e(clamp(d + 1, -8, 8)) + 2) / 4) }
    case 8: { let a = 8; for (let i = 0; i < 8; i++) a += T[i] + L[i]; return clamp(Math.floor(a / 16) + Math.floor((CFL_A * CFL_AC[y * 8 + x] + 16) / 32), 0, 255) }
    default: return clamp(L[y] + T[x] - c, 0, 255)
  }
}

// --- 16x16 blocks: DCT, neighbours, prediction (the 8x8 modes at size 16) ----------------------------------------------
const C16 = new Float64Array(256)
for (let x = 0; x < 16; x++) for (let u = 0; u < 16; u++) C16[x * 16 + u] = +(Math.cos(((2 * x + 1) * u * Math.PI) / 32) * (u ? Math.SQRT1_2 / 2 : 0.25)).toFixed(5)
const ZZ16 = (() => { const z = []; for (let s = 0; s < 31; s++) for (let i = 0; i <= s; i++) { const r = s % 2 ? i : s - i, c = s - r; if (r < 16 && c < 16) z.push(r * 16 + c) } return z })()
const q16of = q => Array.from({ length: 256 }, (_, i) => q[((i >> 4) >> 1) * 8 + ((i & 15) >> 1)])
const Q16L = q16of(TL), Q16C = q16of(TC)
const t16 = new Float64Array(256)
function fdct16(b, out) {
  for (let y = 0; y < 16; y++) for (let u = 0; u < 16; u++) { let a = 0; for (let x = 0; x < 16; x++) a += b[y * 16 + x] * C16[x * 16 + u]; t16[y * 16 + u] = a }
  for (let v = 0; v < 16; v++) for (let u = 0; u < 16; u++) { let a = 0; for (let y = 0; y < 16; y++) a += t16[y * 16 + u] * C16[y * 16 + v]; out[v * 16 + u] = a }
}
/** dq [v * 16 + u] -> out [y * 16 + x] */
function idct16(dq, out) {
  t16.fill(0)
  for (let v = 0; v < 16; v++) for (let u = 0; u < 16; u++) { const q = dq[v * 16 + u]; if (q) for (let x = 0; x < 16; x++) t16[v * 16 + x] += q * C16[x * 16 + u] }
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { let a = 0; for (let v = 0; v < 16; v++) a += t16[v * 16 + x] * C16[y * 16 + v]; out[y * 16 + x] = a }
}
const T16 = new Int32Array(32), L16 = new Int32Array(16)
// CfL at 16x16: the 32 x 32 luma under a chroma superblock, 2x2 sums minus their mean
const CFL_AC16 = new Int32Array(256)
function cflAC16(sx, sy) {
  let sum = 0
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const i = (sy * 32 + 2 * y) * 1280 + sx * 32 + 2 * x
    const v = LUMA[i] + LUMA[i + 1] + LUMA[i + 1280] + LUMA[i + 1281]
    CFL_AC16[y * 16 + x] = v; sum += v
  }
  const m = Math.floor((sum + 128) / 256)
  let e = 0; for (let i = 0; i < 256; i++) { CFL_AC16[i] -= m; e += CFL_AC16[i] ** 2 }
  return e
}
/** tws x ths: the tile in superblocks (luma 20 x 4, chroma 10 x 2) */
function neighbours16(rec, w, sx, sy, tws = 20, ths = 4) {
  const x0 = sx * 16, y0 = sy * 16, hasT = sy % ths > 0, hasL = sx % tws > 0, hasTR = hasT && sx % tws < tws - 1
  const t0 = hasT ? -1 : hasL ? rec[y0 * w + x0 - 1] : 128
  for (let i = 0; i < 32; i++) T16[i] = hasT ? rec[(y0 - 1) * w + x0 + (hasTR ? i : Math.min(i, 15))] : t0
  for (let i = 0; i < 16; i++) L16[i] = hasL ? rec[(y0 + i) * w + x0 - 1] : hasT ? T16[0] : 128
  return hasT && hasL ? rec[(y0 - 1) * w + x0 - 1] : hasT ? T16[0] : hasL ? L16[0] : 128
}
function predict16(m, c, x, y) {
  const T = T16, L = L16
  if (m > 8 || (CUR_D && (m === 1 || m === 2))) return dirPred(T, L, c, 16, x, y, m)
  switch (m) {
    case 0: { let a = 16; for (let i = 0; i < 16; i++) a += T[i] + L[i]; return Math.floor(a / 32) }
    case 1: return T[x]
    case 2: return L[y]
    case 3: { const base = T[x] + L[y] - c, pl = Math.abs(base - L[y]), pt = Math.abs(base - T[x]), pc = Math.abs(base - c)
      return pl <= pt && pl <= pc ? L[y] : pt <= pc ? T[x] : c }
    case 4: return Math.floor(((16 - y) * T[x] + (y + 1) * L[15] + (16 - x) * L[y] + (x + 1) * T[15] + 17) / 34)
    case 5: { const i = x + y; return Math.floor((T[Math.min(i, 31)] + 2 * T[Math.min(i + 1, 31)] + T[Math.min(i + 2, 31)] + 2) / 4) }
    case 6: { const d = x - y, e = k => (k < 0 ? L[-k - 1] : k === 0 ? c : T[k - 1])
      return Math.floor((e(clamp(d - 1, -16, 16)) + 2 * e(clamp(d, -16, 16)) + e(clamp(d + 1, -16, 16)) + 2) / 4) }
    case 8: { let a = 16; for (let i = 0; i < 16; i++) a += T[i] + L[i]; return clamp(Math.floor(a / 32) + Math.floor((CFL_A * CFL_AC16[y * 16 + x] + 16) / 32), 0, 255) }
    default: return clamp(L[y] + T[x] - c, 0, 255)
  }
}

const ROI = process.env.ROI ? process.env.ROI.split(',').map(Number) : undefined
function roiWeight(x, y) {
  if (!ROI) return 1
  const [cx, cy, rx, ry, wb] = ROI, f = clamp(2 - Math.hypot((x - cx) / rx, (y - cy) / ry), 0, 1)
  return wb + (1 - wb) * f * f * (3 - 2 * f)
}


// --- the model: a static 16-letter table per context ------------------------------------------------------------------
const BASE = [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192], EXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 13]
const CLS = new Uint8Array(8400); for (let v = 0, c = 0; v < 8400; v++) { while (c < 15 && BASE[c + 1] <= v) c++; CLS[v] = c }
const bucket = e => Array.from({ length: 300 }, (_, v) => e.filter(x => v >= x).length)
const NBK = bucket([1, 3, 6]), RBK = bucket([1, 3, 6, 10, 20]), KBK = bucket([2, 3, 5, 8, 12, 20, 32]), LBK = bucket([2, 3])
const cN = (p, prevN) => 5 + p * 4 + NBK[prevN]
const cRun = (p, last, rem) => 17 + p * 18 + RBK[last] * 3 + LBK[rem]
const cLev = (p, kc, rem) => 71 + p * 24 + KBK[kc] * 3 + LBK[rem]
// 16x16 contexts: partition 145 + left superblock's partition; mode 147; DC 148; n 149 + NBK; run 153 + 3 RBK16 + LBK;
// level 174 + 3 KBK16 + LBK (197 the last)
const RBK16 = bucket([1, 4, 10, 24, 48, 96]), KBK16 = bucket([2, 4, 8, 16, 32, 64, 128])
const cPart = l => 145 + l, CM16 = 147, CDC16 = 148
const cN16 = prevN => 149 + NBK[prevN]
const cRun16 = (last, rem) => 153 + RBK16[last] * 3 + LBK[rem]
const cLev16 = (kc, rem) => 174 + KBK16[kc] * 3 + LBK[rem]
// chroma superblocks (Co and Cg share partition and mode; 16x16 blocks of both planes share contexts): the luma 16x16
// contexts + OC: partition 198-199, mode 200, DC 201, n 202-205, run 206-226, level 227-250
const OC = 53
const sem = v => (v <= 0 ? -2 * v : 2 * v - 1)
const mIdx = m => (m > 8 ? m - 1 : m)
const modeLetter = (m, mpm) => (m === mpm ? 0 : 1 + (mIdx(m) < mIdx(mpm) ? mIdx(m) : mIdx(m) - 1))
/** luma: the mode a letter names after mpm */
const lumaMode = (l, mpm) => { if (l === 0) return mpm; const r = l - 1 < mIdx(mpm) ? l - 1 : l; return r >= 8 ? r + 1 : r }
const COST = new Float64Array(NCTX * 16)
{ // to start: Exp-Golomb lengths
  const ueb = v => 2 * Math.floor(Math.log2(v + 1)) + 1
  for (let c0 = 0; c0 < NCTX; c0++) for (let s = 0; s < 16; s++) {
    const c = c0 >= 145 + OC ? c0 - OC : c0 // chroma 16x16 contexts start like luma's
    COST[c0 * 16 + s] = c === 143 || c === 144 ? 4 : c === 145 || c === 146 ? 1 : c < 2 || c === CM16 ? (s ? 4 : 1)
      : (c >= 5 && c < 17) || (c >= 149 && c < 153) ? ueb(s) : Math.max(1, ueb(BASE[s]) - EXT[s])
  }
}
/** bits for a block's levels (zigzag; [0] the DC) in plane p, after a block with prevN entries */
function blockRate(lv, p, prevN) {
  const dc = CLS[sem(lv[0])]
  let n = 0; for (let k = 1; k < 64; k++) if (lv[k]) n++
  let b = COST[(2 + p) * 16 + dc] + EXT[dc] + (ESC ? COST[cN(p, prevN) * 16 + Math.min(n, 15)] + escBits(n, 6) : n < 16 ? COST[cN(p, prevN) * 16 + n] : COST[cN(p, prevN) * 16 + 15] + 2 * (n - 15))
  let last = 0, j = 0
  for (let k = 1; k < 64; k++) if (lv[k]) {
    const rem = n - j, rc = CLS[k - last - 1], lc = CLS[Math.abs(lv[k]) - 1]
    b += COST[cRun(p, last, rem) * 16 + rc] + COST[cLev(p, Math.min(last + BASE[rc] + 1, 63), rem) * 16 + lc] + EXT[rc] + EXT[lc] + 1
    last = k; j++
  }
  return b
}
/** a block's symbols, in stream order: letter(ctx, s), raw(k, value); returns its entry count */
function blockSymbols(b, p, prevN, withMode, letter, raw) {
  if (withMode) letter(p, modeLetter(b.mode, b.mpm))
  if (p === 0 && DELTA && isDir(b.mode)) letter(CDELTA, b.delta + 2)
  if (p > 0 && b.mode === 8) letter(142 + p, b.alpha)
  const dv = sem(b.lv[0]), dc = CLS[dv]
  letter(2 + p, dc); raw(EXT[dc], dv - BASE[dc])
  const nz = []; for (let k = 1; k < 64; k++) if (b.lv[k]) nz.push(k)
  letter(cN(p, prevN), Math.min(nz.length, 15)); if (escBits(nz.length, 6)) raw(6, nz.length - 15)
  let last = 0
  nz.forEach((k, j) => {
    const rem = nz.length - j, r = k - last - 1, rc = CLS[r], a = Math.abs(b.lv[k]) - 1, lc = CLS[a]
    letter(cRun(p, last, rem), rc); letter(cLev(p, Math.min(last + BASE[rc] + 1, 63), rem), lc)
    raw(EXT[rc] + EXT[lc] + 1, ((r - BASE[rc]) * 2 ** EXT[lc] + (a - BASE[lc])) * 2 + (b.lv[k] < 0 ? 1 : 0))
    last = k
  })
  return nz.length
}
/** bits for a 16x16 block's levels (zigzag, 256); o: context offset (0 luma, OC chroma) */
function blockRate16(lv, prevN, o = 0) {
  const dc = CLS[sem(lv[0])]
  let n = 0; for (let k = 1; k < 256; k++) if (lv[k]) n++
  let b = COST[(CDC16 + o) * 16 + dc] + EXT[dc] + COST[(cN16(prevN) + o) * 16 + Math.min(n, 15)] + (ESC ? escBits(n, 8) : 2 * Math.max(0, n - 15))
  let last = 0, j = 0
  for (let k = 1; k < 256; k++) if (lv[k]) {
    const rem = n - j, rc = CLS[k - last - 1], lc = CLS[Math.abs(lv[k]) - 1]
    b += COST[(cRun16(last, rem) + o) * 16 + rc] + COST[(cLev16(Math.min(last + BASE[rc] + 1, 255), rem) + o) * 16 + lc] + EXT[rc] + EXT[lc] + 1
    last = k; j++
  }
  return b
}
/** p: plane (0 Y, 1 Co, 2 Cg); chroma 16x16 blocks share contexts OC on; the mode letter only with withMode, the
 *  CfL alpha letter after it (Co) or first (Cg) */
function blockSymbols16(b, prevN, letter, raw, p = 0, withMode = true) {
  const o = p ? OC : 0
  if (withMode) letter(CM16 + o, modeLetter(b.mode, b.mpm))
  if (p === 0 && DELTA && isDir(b.mode)) letter(CDELTA, b.delta + 2)
  if (p > 0 && b.mode === 8) letter(142 + p, b.alpha)
  const dv = sem(b.lv[0]), dc = CLS[dv]
  letter(CDC16 + o, dc); raw(EXT[dc], dv - BASE[dc])
  const nz = []; for (let k = 1; k < 256; k++) if (b.lv[k]) nz.push(k)
  letter(cN16(prevN) + o, Math.min(nz.length, 15)); if (escBits(nz.length, 8)) raw(8, nz.length - 15)
  let last = 0
  nz.forEach((k, j) => {
    const rem = nz.length - j, r = k - last - 1, rc = CLS[r], a = Math.abs(b.lv[k]) - 1, lc = CLS[a]
    letter(cRun16(last, rem) + o, rc); letter(cLev16(Math.min(last + BASE[rc] + 1, 255), rem) + o, lc)
    raw(EXT[rc] + EXT[lc] + 1, ((r - BASE[rc]) * 2 ** EXT[lc] + (a - BASE[lc])) * 2 + (b.lv[k] < 0 ? 1 : 0))
    last = k
  })
  return nz.length
}
/** every symbol of the picture in stream order; slice() before each slice (luma: a superblock row; chroma: a block row) */
function eachSymbol(enc, letter, raw, slice = () => {}) {
  const sbs = enc.y.sbs
  for (let sy = 0; sy < 48; sy++) {
    slice(); let prevN = 0
    for (let sx = 0; sx < 80; sx++) {
      const sb = sbs[sy * 80 + sx]
      if (PART) letter(cPart(sx % 20 > 0 ? sbs[sy * 80 + sx - 1].part : 0), sb.part)
      if (sb.part === 0) prevN = blockSymbols16(sb.b, prevN, letter, raw)
      else for (const b of sb.subs) prevN = blockSymbols(b, 0, prevN, true, letter, raw)
    }
  }
  const csb = enc.c.sbs
  for (const p of [1, 2]) {
    const g = p - 1
    for (let sy = 0; sy < 24; sy++) {
      slice(); let prevN = 0
      for (let sx = 0; sx < 40; sx++) {
        const sb = csb[sy * 40 + sx]
        if (PARTC && p === 1) letter(cPart(sx % 10 > 0 ? csb[sy * 40 + sx - 1].part : 0) + OC, sb.part)
        if (sb.part === 0) prevN = blockSymbols16(sb.b16[g], prevN, letter, raw, p, p === 1)
        else for (const pair of sb.subs) prevN = blockSymbols(pair[g], p, prevN, p === 1, letter, raw)
      }
    }
  }
}
/** tables from the letters an encoding uses: per context the cumulative frequencies (of 256) of letters 1..last */
function buildTables(enc) {
  const cnt = new Float64Array(NCTX * 16)
  eachSymbol(enc, (c, s) => cnt[c * 16 + s]++, () => {})
  const offs = [0], bytes = [], cdfs = []
  for (let c = 0; c < NCTX; c++) {
    const n = cnt.slice(c * 16, c * 16 + 16), tot = n.reduce((a, x) => a + x, 0)
    let last = 15; while (last > 0 && !n[last]) last--
    const q = Array.from(n, x => (x ? Math.max(1, Math.round((x / tot) * 256)) : 0))
    if (!tot) q[0] = 256
    const sum = q.reduce((a, x) => a + x, 0), big = q.indexOf(Math.max(...q)); q[big] += 256 - sum
    const cdf = [0]; for (let s = 0; s < 16; s++) cdf.push(cdf[s] + q[s])
    for (let s = 1; s <= last; s++) bytes.push(cdf[s])
    offs.push(bytes.length); cdfs.push({ cdf, last })
    for (let s = 0; s < 16; s++) COST[c * 16 + s] = q[s] ? -Math.log2(q[s] / 256) : 12
  }
  return { offs, bytes, cdfs }
}

// --- encoding ---------------------------------------------------------------------------------------------------------
const src = new Float64Array(64), pr = new Int32Array(64), co = new Float64Array(64), dq = new Float64Array(64), rs = new Int32Array(64)
/** codes src - pr: levels (zigzag) -> lvOut, reconstruction -> rs; returns bits */
function codeBlock(st, lam, lvOut, p, prevN) {
  for (let i = 0; i < 64; i++) dq[i] = src[i] - pr[i]
  fdct(dq, co)
  const lv = lvOut
  for (let k = 0; k < 64; k++) lv[k] = clamp(Math.round(co[ZZ[k]] / st[k]), -4000, 4000)
  let rate = blockRate(lv, p, prevN)
  for (let k = 63; k >= 1; k--) {
    const l = lv[k]; if (!l) continue
    const e0 = (co[ZZ[k]] - l * st[k]) ** 2; let bestL = l, bestJ = 0
    const t1 = Math.abs(l) > 1 ? l - Math.sign(l) : 0
    for (const t of t1 ? [t1, 0] : [0]) { lv[k] = t; const J = (co[ZZ[k]] - t * st[k]) ** 2 - e0 + lam * (blockRate(lv, p, prevN) - rate); if (J < bestJ) { bestJ = J; bestL = t } }
    lv[k] = bestL; rate = blockRate(lv, p, prevN)
  }
  let nz = 0; for (let k = 1; k < 64; k++) if (lv[k] && ++nz > CAP) lv[k] = 0
  recon(lv, ZZ, p ? TC : TL, 8, pr, rs)
  return blockRate(lv, p, prevN)
}
/** group: Y alone, or [Co, Cg] sharing a mode. -> per plane: rec, per block: { mode, mpm, levels } */
function codeGroup(group, w, h, Q, s, pis, tw, th, px) {
  const bw = w / 8, bh = h / 8, recs = group.map(() => new Int32Array(w * h)), modes = new Int8Array(bw * bh)
  const st = ZZ.map(z => Q[z] * s), lam0 = RDO_L * (16 * s) ** 2
  const blocks = group.map(() => []), lvTry = new Int32Array(64), prevN = group.map(() => 0)
  let bits = 0
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    if (bx === 0) prevN.fill(0)
    const mpm = bx % tw > 0 ? modes[by * bw + bx - 1] : 0
    const lam = lam0 / roiWeight((bx + 0.5) * px, (by + 0.5) * px)
    let bestJ = Infinity, bestM = 0, bestA = [0, 0]
    const acE = CFL && group.length > 1 ? cflAC(bx, by) : 0
    for (let m = 0; m < (CFL && group.length > 1 ? 9 : 8); m++) {
      let J = 0, b = COST[pis[0] * 16 + modeLetter(m, mpm)]
      const al = [0, 0]
      for (let g = 0; g < group.length; g++) {
        const p = group[g], c = neighbours(recs[g], w, bx, by, tw, th)
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) src[y * 8 + x] = p[(by * 8 + y) * w + bx * 8 + x]
        let cands = [0]
        if (m === 8) {
          CFL_A = 0; let rx = 0; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) rx += (src[y * 8 + x] - predictAt(8, c, x, y)) * CFL_AC[y * 8 + x]
          const a = acE ? (32 * rx) / acE : 0
          const ord = A8.map((v, i) => i).sort((i, j) => Math.abs(A8[i] - a) - Math.abs(A8[j] - a))
          cands = ord.slice(0, 2)
        }
        let gJ = Infinity, gB = 0
        for (const ai of cands) {
          CFL_A = A8[ai]
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pr[y * 8 + x] = predictAt(m, c, x, y)
          let bb = codeBlock(st, lam / WEIGHT[pis[g]], lvTry, pis[g], prevN[g]) + (m === 8 ? COST[(143 + g) * 16 + ai] : 0)
          let d = 0; for (let i = 0; i < 64; i++) d += (src[i] - rs[i]) ** 2
          const jj = WEIGHT[pis[g]] * d + lam * bb
          if (jj < gJ) { gJ = jj; gB = bb; al[g] = ai }
        }
        b += gB; J += gJ - lam * gB
      }
      J += lam * b
      if (J < bestJ) { bestJ = J; bestM = m; bestA = al }
    }
    let b = COST[pis[0] * 16 + modeLetter(bestM, mpm)]
    for (let g = 0; g < group.length; g++) {
      const p = group[g], rec = recs[g], c = neighbours(rec, w, bx, by, tw, th)
      CFL_A = A8[bestA[g]]
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { src[y * 8 + x] = p[(by * 8 + y) * w + bx * 8 + x]; pr[y * 8 + x] = predictAt(bestM, c, x, y) }
      const lv = new Int32Array(64)
      b += codeBlock(st, lam / WEIGHT[pis[g]], lv, pis[g], prevN[g]) + (bestM === 8 ? COST[(143 + g) * 16 + bestA[g]] : 0)
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) rec[(by * 8 + y) * w + bx * 8 + x] = rs[y * 8 + x]
      blocks[g].push({ mode: bestM, mpm, lv, alpha: bestA[g] })
      let n = 0; for (let k = 1; k < 64; k++) if (lv[k]) n++
      prevN[g] = n
    }
    modes[by * bw + bx] = bestM; bits += b
  }
  return { bits, recs, blocks }
}
const src16 = new Float64Array(256), pr16 = new Int32Array(256), co16 = new Float64Array(256), dq16 = new Float64Array(256), rs16 = new Int32Array(256), out16 = new Float64Array(256)
/** codeBlock at 16x16: src16 - pr16 -> lvOut (zigzag, 256), rs16; returns bits */
function codeBlock16(st, lam, lvOut, prevN, o = 0) {
  for (let i = 0; i < 256; i++) dq16[i] = src16[i] - pr16[i]
  fdct16(dq16, co16)
  const lv = lvOut
  for (let k = 0; k < 256; k++) lv[k] = clamp(Math.round(co16[ZZ16[k]] / st[k]), -4000, 4000)
  let rate = blockRate16(lv, prevN, o)
  for (let k = 255; k >= 1; k--) {
    const l = lv[k]; if (!l) continue
    const e0 = (co16[ZZ16[k]] - l * st[k]) ** 2; let bestL = l, bestJ = 0
    const t1 = Math.abs(l) > 1 ? l - Math.sign(l) : 0
    for (const t of t1 ? [t1, 0] : [0]) { lv[k] = t; const J = (co16[ZZ16[k]] - t * st[k]) ** 2 - e0 + lam * (blockRate16(lv, prevN, o) - rate); if (J < bestJ) { bestJ = J; bestL = t } }
    lv[k] = bestL; rate = blockRate16(lv, prevN, o)
  }
  let nz = 0; for (let k = 1; k < 256; k++) if (lv[k] && ++nz > CAP) lv[k] = 0
  recon(lv, ZZ16, o ? Q16C : Q16L, 16, pr16, rs16)
  return blockRate16(lv, prevN, o)
}
const lv8Try = new Int32Array(64), lv16Try = new Int32Array(256)
/** one luma 8x8 block (bx, by) with its mode search; writes rec and modes */
/** bits of a luma mode letter (+ its delta letter) in context ctx */
const modeBits = (ctx, m, dl, mpm) => COST[ctx * 16 + modeLetter(m, mpm)] + (DELTA && isDir(m) ? COST[CDELTA * 16 + dl + 2] : 0)
/** every luma mode at delta 0, then deltas on the two best directional ones; trial(m, d) -> J. -> [mode, delta] */
function searchModes(trial) {
  let bJ = Infinity, bM = 0, bD = 0
  const dirJ = []
  for (const m of LUMA_MODES) { const J = trial(m, 0); if (J < bJ) { bJ = J; bM = m } if (isDir(m)) dirJ.push([J, m]) }
  if (DELTA) for (const [, m] of dirJ.sort((a, b) => a[0] - b[0]).slice(0, 2)) for (const dl of [-2, -1, 1, 2]) {
    const J = trial(m, dl); if (J < bJ) { bJ = J; bM = m; bD = dl }
  }
  return [bM, bD]
}
function code8(rec, modes, st, lam, bx, by, prevN, noTR) {
  const w = CW, mpm = bx % 40 > 0 ? modes[by * 160 + bx - 1] : 0, c = neighbours(rec, w, bx, by, 40, 8, noTR)
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) src[y * 8 + x] = Y[(by * 8 + y) * w + bx * 8 + x]
  const trial = (m, dl) => {
    CUR_D = dl
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pr[y * 8 + x] = predictAt(m, c, x, y)
    const b = modeBits(0, m, dl, mpm) + codeBlock(st, lam, lv8Try, 0, prevN)
    let d = 0; for (let i = 0; i < 64; i++) d += (src[i] - rs[i]) ** 2
    return d + lam * b
  }
  const [bM, bD] = searchModes(trial)
  CUR_D = bD
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pr[y * 8 + x] = predictAt(bM, c, x, y)
  const lv = new Int32Array(64), bits = modeBits(0, bM, bD, mpm) + codeBlock(st, lam, lv, 0, prevN)
  let d = 0; for (let i = 0; i < 64; i++) d += (src[i] - rs[i]) ** 2
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) rec[(by * 8 + y) * w + bx * 8 + x] = rs[y * 8 + x]
  modes[by * 160 + bx] = bM
  let n = 0; for (let k = 1; k < 64; k++) if (lv[k]) n++
  return { mode: bM, mpm, lv, bits, d, n, delta: bD }
}
const SUBS = [[0, 0, false], [1, 0, false], [0, 1, false], [1, 1, true]] // z-order; the last has no above-right
/** luma by superblock: one 16x16 or four 8x8, by RD */
function codeLuma(s) {
  const w = CW, rec = new Int32Array(w * CH), modes = new Int8Array(160 * 96), sbs = []
  const st = ZZ.map(z => TL[z] * s), Q16 = q16of(TL), st16 = ZZ16.map(z => Q16[z] * s), lam0 = RDO_L * (16 * s) ** 2
  const keep = new Int32Array(256)
  let bits = 0, prevN = 0, n16 = 0
  for (let sy = 0; sy < 48; sy++) for (let sx = 0; sx < 80; sx++) {
    if (sx === 0) prevN = 0
    const lam = lam0 / roiWeight((sx + 0.5) * 16, (sy + 0.5) * 16)
    const pctx = cPart(sx % 20 > 0 ? sbs[sbs.length - 1].part : 0)
    let J16 = Infinity, b16
    if (PART) {
      const mpm = sx % 20 > 0 ? modes[2 * sy * 160 + 2 * sx - 1] : 0, c = neighbours16(rec, w, sx, sy)
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) src16[y * 16 + x] = Y[(sy * 16 + y) * w + sx * 16 + x]
      const [bM, bD] = searchModes((m, dl) => {
        CUR_D = dl
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pr16[y * 16 + x] = predict16(m, c, x, y)
        const b = modeBits(CM16, m, dl, mpm) + codeBlock16(st16, lam, lv16Try, prevN)
        let d = 0; for (let i = 0; i < 256; i++) d += (src16[i] - rs16[i]) ** 2
        return d + lam * b
      })
      CUR_D = bD
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pr16[y * 16 + x] = predict16(bM, c, x, y)
      const lv = new Int32Array(256), b = modeBits(CM16, bM, bD, mpm) + codeBlock16(st16, lam, lv, prevN) + COST[pctx * 16]
      let d = 0; for (let i = 0; i < 256; i++) d += (src16[i] - rs16[i]) ** 2
      keep.set(rs16); J16 = d + lam * b
      let n = 0; for (let k = 1; k < 256; k++) if (lv[k]) n++
      b16 = { b: { mode: bM, mpm, lv, delta: bD }, bits: b, n }
    }
    // four 8x8 (written into rec and modes; undone below if the 16x16 wins)
    let pn = prevN, b8 = PART ? COST[pctx * 16 + 1] : 0, d8 = 0
    const subs = SUBS.map(([i, j, noTR]) => {
      const r = code8(rec, modes, st, lam0 / roiWeight((2 * sx + i + 0.5) * 8, (2 * sy + j + 0.5) * 8), 2 * sx + i, 2 * sy + j, pn, noTR)
      pn = r.n; b8 += r.bits; d8 += r.d; return r
    })
    if (J16 < d8 + lam * b8) {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) rec[(sy * 16 + y) * w + sx * 16 + x] = keep[y * 16 + x]
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) modes[(2 * sy + j) * 160 + 2 * sx + i] = b16.b.mode
      sbs.push({ part: 0, b: b16.b }); bits += b16.bits; prevN = b16.n; n16++
    } else {
      sbs.push({ part: 1, subs }); bits += b8; prevN = pn
    }
  }
  return { bits, rec, sbs, n16 }
}
const PARTC = process.env.PARTC !== '0'
/** one chroma 8x8 pair (Co, Cg share the mode) at (bx, by), mode search as codeGroup; writes recs and modes */
function codeC8(recs, modes, st, lam, bx, by, prevN, noTR) {
  const w = 640, group = [CoH, CgH], mpm = bx % 20 > 0 ? modes[by * 80 + bx - 1] : 0
  const acE = CFL ? cflAC(bx, by) : 0
  let bestJ = Infinity, bestM = 0, bestA = [0, 0]
  for (let m = 0; m < (CFL ? 9 : 8); m++) {
    let J = lam * COST[16 + modeLetter(m, mpm)]
    const al = [0, 0]
    for (let g = 0; g < 2; g++) {
      const p = group[g], c = neighbours(recs[g], w, bx, by, 20, 4, noTR)
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) src[y * 8 + x] = p[(by * 8 + y) * w + bx * 8 + x]
      let cands = [0]
      if (m === 8) {
        CFL_A = 0; let rx = 0; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) rx += (src[y * 8 + x] - predictAt(8, c, x, y)) * CFL_AC[y * 8 + x]
        const a = acE ? (32 * rx) / acE : 0
        cands = A8.map((v, i) => i).sort((i, j) => Math.abs(A8[i] - a) - Math.abs(A8[j] - a)).slice(0, 2)
      }
      let gJ = Infinity
      for (const ai of cands) {
        CFL_A = A8[ai]
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pr[y * 8 + x] = predictAt(m, c, x, y)
        const bb = codeBlock(st, lam / WEIGHT[g + 1], lv8Try, g + 1, prevN[g]) + (m === 8 ? COST[(143 + g) * 16 + ai] : 0)
        let d = 0; for (let i = 0; i < 64; i++) d += (src[i] - rs[i]) ** 2
        const jj = WEIGHT[g + 1] * d + lam * bb
        if (jj < gJ) { gJ = jj; al[g] = ai }
      }
      J += gJ
    }
    if (J < bestJ) { bestJ = J; bestM = m; bestA = al }
  }
  let bits = COST[16 + modeLetter(bestM, mpm)], dW = 0
  const blocks = [], ns = []
  for (let g = 0; g < 2; g++) {
    const p = group[g], rec = recs[g], c = neighbours(rec, w, bx, by, 20, 4, noTR)
    CFL_A = A8[bestA[g]]
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { src[y * 8 + x] = p[(by * 8 + y) * w + bx * 8 + x]; pr[y * 8 + x] = predictAt(bestM, c, x, y) }
    const lv = new Int32Array(64)
    bits += codeBlock(st, lam / WEIGHT[g + 1], lv, g + 1, prevN[g]) + (bestM === 8 ? COST[(143 + g) * 16 + bestA[g]] : 0)
    let d = 0; for (let i = 0; i < 64; i++) d += (src[i] - rs[i]) ** 2
    dW += WEIGHT[g + 1] * d
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) rec[(by * 8 + y) * w + bx * 8 + x] = rs[y * 8 + x]
    blocks.push({ mode: bestM, mpm, lv, alpha: bestA[g] })
    let n = 0; for (let k = 1; k < 64; k++) if (lv[k]) n++
    ns.push(n)
  }
  modes[by * 80 + bx] = bestM
  return { blocks, bits, dW, ns }
}
/** chroma by superblock (40 x 24, tile 10 x 2): one 16x16 pair or four 8x8 pairs, by RD */
function codeChroma(s) {
  CUR_D = 0
  const w = 640, recs = [new Int32Array(w * 384), new Int32Array(w * 384)], modes = new Int8Array(80 * 48), sbs = [], group = [CoH, CgH]
  const st = ZZ.map(z => TC[z] * s), Q16 = q16of(TC), st16 = ZZ16.map(z => Q16[z] * s), lam0 = RDO_L * (16 * s) ** 2
  const keep = [new Int32Array(256), new Int32Array(256)]
  let bits = 0, n16 = 0
  const prevN = [0, 0]
  for (let sy = 0; sy < 24; sy++) for (let sx = 0; sx < 40; sx++) {
    if (sx === 0) prevN.fill(0)
    const lam = lam0 / roiWeight((sx + 0.5) * 32, (sy + 0.5) * 32)
    const pctx = cPart(sx % 10 > 0 ? sbs[sbs.length - 1].part : 0) + OC
    let J16 = Infinity, r16
    if (PARTC) {
      const mpm = sx % 10 > 0 ? modes[2 * sy * 80 + 2 * sx - 1] : 0
      const acE = CFL ? cflAC16(sx, sy) : 0
      let bestJ = Infinity, bestM = 0, bestA = [0, 0]
      for (let m = 0; m < (CFL ? 9 : 8); m++) {
        let J = lam * COST[(CM16 + OC) * 16 + modeLetter(m, mpm)]
        const al = [0, 0]
        for (let g = 0; g < 2; g++) {
          const p = group[g], c = neighbours16(recs[g], w, sx, sy, 10, 2)
          for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) src16[y * 16 + x] = p[(sy * 16 + y) * w + sx * 16 + x]
          let cands = [0]
          if (m === 8) {
            CFL_A = 0; let rx = 0; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) rx += (src16[y * 16 + x] - predict16(8, c, x, y)) * CFL_AC16[y * 16 + x]
            const a = acE ? (32 * rx) / acE : 0
            cands = A8.map((v, i) => i).sort((i, j) => Math.abs(A8[i] - a) - Math.abs(A8[j] - a)).slice(0, 2)
          }
          let gJ = Infinity
          for (const ai of cands) {
            CFL_A = A8[ai]
            for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pr16[y * 16 + x] = predict16(m, c, x, y)
            const bb = codeBlock16(st16, lam / WEIGHT[g + 1], lv16Try, prevN[g], OC) + (m === 8 ? COST[(143 + g) * 16 + ai] : 0)
            let d = 0; for (let i = 0; i < 256; i++) d += (src16[i] - rs16[i]) ** 2
            const jj = WEIGHT[g + 1] * d + lam * bb
            if (jj < gJ) { gJ = jj; al[g] = ai }
          }
          J += gJ
        }
        if (J < bestJ) { bestJ = J; bestM = m; bestA = al }
      }
      let b = COST[(CM16 + OC) * 16 + modeLetter(bestM, mpm)] + COST[pctx * 16], dW = 0
      const blocks = [], ns = []
      for (let g = 0; g < 2; g++) {
        const p = group[g], c = neighbours16(recs[g], w, sx, sy, 10, 2)
        CFL_A = A8[bestA[g]]
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { src16[y * 16 + x] = p[(sy * 16 + y) * w + sx * 16 + x]; pr16[y * 16 + x] = predict16(bestM, c, x, y) }
        const lv = new Int32Array(256)
        b += codeBlock16(st16, lam / WEIGHT[g + 1], lv, prevN[g], OC) + (bestM === 8 ? COST[(143 + g) * 16 + bestA[g]] : 0)
        let d = 0; for (let i = 0; i < 256; i++) d += (src16[i] - rs16[i]) ** 2
        dW += WEIGHT[g + 1] * d; keep[g].set(rs16)
        blocks.push({ mode: bestM, mpm, lv, alpha: bestA[g] })
        let n = 0; for (let k = 1; k < 256; k++) if (lv[k]) n++
        ns.push(n)
      }
      J16 = dW + lam * b; r16 = { blocks, bits: b, ns }
    }
    let b8 = PARTC ? COST[(pctx) * 16 + 1] : 0, d8 = 0
    const pn = [...prevN]
    const subs = SUBS.map(([i, j, noTR]) => {
      const r = code8C(i, j, noTR); b8 += r.bits; d8 += r.dW; pn[0] = r.ns[0]; pn[1] = r.ns[1]; return r.blocks
    })
    function code8C(i, j, noTR) { return codeC8(recs, modes, st, lam0 / roiWeight((2 * sx + i + 0.5) * 16, (2 * sy + j + 0.5) * 16), 2 * sx + i, 2 * sy + j, pn, noTR) }
    if (J16 < d8 + lam * b8) {
      for (let g = 0; g < 2; g++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) recs[g][(sy * 16 + y) * w + sx * 16 + x] = keep[g][y * 16 + x]
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) modes[(2 * sy + j) * 80 + 2 * sx + i] = r16.blocks[0].mode
      sbs.push({ part: 0, b16: r16.blocks }); bits += r16.bits; prevN[0] = r16.ns[0]; prevN[1] = r16.ns[1]; n16++
    } else {
      sbs.push({ part: 1, subs }); bits += b8; prevN[0] = pn[0]; prevN[1] = pn[1]
    }
  }
  return { bits, recs, sbs, n16 }
}
function modeStats(enc) {
  const n = new Array(9).fill(0)
  enc.c.sbs.forEach(sb => { if (sb.part === 0) n[sb.b16[0].mode] += 4; else sb.subs.forEach(pr => n[pr[0].mode]++) })
  return n.join(' ')
}
function encode(s) {
  S4096 = Math.round(s * 4096)
  s = S4096 / 4096
  const y = codeLuma(s)
  LUMA = y.rec
  const c = codeChroma(s)
  return { bits: y.bits + c.bits, y, c }
}

// --- the range coder (the shader's decoder, mirrored) -------------------------------------------------------------------
function rangeEncoder(tab) {
  let low = 0n, R = 0xffffff, total = 24
  const norm = () => { let sh = 0; while (R < 0x800000) { R *= 2; sh++ } if (sh) { low <<= BigInt(sh); total += sh } }
  const span = (lo, hi) => { low += BigInt(lo); R = hi - lo; norm() }
  return {
    letter(c, s) {
      const { cdf, last } = tab.cdfs[c]
      if (s > last || cdf[s + 1] === cdf[s]) throw new Error(`letter ${s} of context ${c} has no room`)
      const r = Math.floor(R / 256); span(r * cdf[s], s < last ? r * cdf[s + 1] : R)
    },
    raw(k, q) { if (!k) return; if (k > 23) throw new Error(`raw ${k} bits`); const r = Math.floor(R / 2 ** k), m = 2 ** k - 1; span(q * r, q < m ? (q + 1) * r : R) },
    /** the shortest bit string whose every continuation stays inside [low, low + R) */
    finish() {
      const end = low + BigInt(R)
      for (let m = total; m >= 0; m--) { const u = 1n << BigInt(m), c = (low + u - 1n) / u; if ((c + 1n) * u <= end) return { c, len: total - m } }
      throw new Error('no flush')
    },
  }
}

// --- search: s to fill the budget, tables from the letters used, four rounds (the last with a thin margin) ------------------------------------------
let tab, s = 1.8, enc
const tableWords = t => Math.ceil(t.bytes.length / 3)
if (process.env.FIXS) {
  s = Math.round(+process.env.FIXS * 4096) / 4096
  for (let r = 0; r < 2; r++) { enc = encode(s); tab = buildTables(enc) }
  console.log(`fixed s ${s.toFixed(4)}, model bits ${enc.bits.toFixed(0)}, tables ${tab.bytes.length} bytes`)
} else for (let round = 0; round < 4; round++) {
  const avail = (SWORDS - CB0 - (tab ? tableWords(tab) : 700)) * 24 - (round < 3 ? 1200 : 150)
  let lo = round ? s / 1.25 : 0.3, hi = round ? s * 1.25 : 20, best
  for (let it = 0; it < (round ? 9 : 13); it++) { const t = Math.sqrt(lo * hi), e = encode(t); if (e.bits > avail) lo = t; else { hi = t; best = t } }
  if (!best) throw new Error('cannot fit')
  s = Math.ceil(best * 4096) / 4096
  enc = encode(s); tab = buildTables(enc)
  console.log(`round ${round}: s ${s.toFixed(4)}, model bits ${enc.bits.toFixed(0)} of ${avail}, tables ${tab.bytes.length} bytes`)
}
// the real stream, with the tables built from its own letters; nudge s up if it overflows
let bitsOut, starts, SS, STREAM_BITS
for (;;) {
  bitsOut = []; starts = []
  let rc
  const flush = () => { if (rc) { const { c, len } = rc.finish(); for (let i = len - 1; i >= 0; i--) bitsOut.push(Number((c >> BigInt(i)) & 1n)) } }
  eachSymbol(enc, (c, v) => rc.letter(c, v), (k, q) => rc.raw(k, q), () => { flush(); starts.push(bitsOut.length); rc = rangeEncoder(tab) })
  flush()
  SS = CB0 + tableWords(tab); STREAM_BITS = (SWORDS - SS) * 24
  if (bitsOut.length <= STREAM_BITS - 48) break
  console.log(`overflow: ${bitsOut.length} of ${STREAM_BITS}; s up`)
  s = Math.ceil(s * 1.004 * 4096) / 4096; enc = encode(s); tab = buildTables(enc)
}
if (starts.length !== 96) throw new Error(`${starts.length} slices`)

const words = new Array(WORDS).fill(0)
words[0] = 0x50524c
if (!V2) pack.scale.forEach((v, h) => { words[1 + h] = Math.round(v * 65536) })
words[4] = pack.loopMs ?? 8000; words[5] = Math.round((CW / PH) * 1e6); words[6] = pack.W; words[7] = pack.H
words[8] = 0x4b4132; words[9] = Math.round(s * 4096); words[10] = SS
if (V2) {
  const MW = pack.words.length
  words[12] = 0x4d5632; words[13] = ((pack.GX > 24 ? 1 : 0) << 19) | (pack.K << 15) | (pack.T << 8) | (pack.WB << 4) | pack.CB
  words[14] = MW; words[15] = pack.movers
  pack.words.forEach((w, i) => { words[i < 1008 ? 16 + i : WORDS - MW + i] = w })
} else pack.ints.forEach((row, n) => row.forEach((w, h) => { words[16 + n * 3 + h] = w }))
starts.forEach((b, i) => { words[1024 + i] = b })
;[...TL, ...TC].forEach((v, e) => { words[T0 + Math.floor(e / 3)] |= v << (8 * (2 - (e % 3))) })
tab.offs.forEach((o, c) => { words[CT0 + (c >> 1)] |= o << (c & 1 ? 0 : 12) })
tab.bytes.forEach((v, e) => { words[CB0 + Math.floor(e / 3)] |= v << (8 * (2 - (e % 3))) })
for (let i = 0; i < bitsOut.length; i++) if (bitsOut[i]) words[SS + Math.floor(i / 24)] |= 1 << (23 - (i % 24))

// --- decode from the words alone, the shader's way ---------------------------------------------------------------------
const at = i => words[i] ?? 0
const SSd = at(10)
const sbit = p => (at(SSd + Math.floor(p / 24)) >>> (23 - (p % 24))) & 1
const readBits = (p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + sbit(p + i); return v }
const tByte = t => (at(CB0 + Math.floor(t / 3)) >>> (8 * (2 - (t % 3)))) & 255
const tOff = c => (at(CT0 + (c >> 1)) >>> (c & 1 ? 0 : 12)) & 4095
function rangeDecoder(p0) {
  let V = readBits(p0, 24), R = 0xffffff, pos = p0 + 24
  const norm = () => {
    let sh = 0
    if (R < 256) { sh += 16; R *= 65536 } if (R < 65536) { sh += 8; R *= 256 } if (R < 1048576) { sh += 4; R *= 16 }
    if (R < 4194304) { sh += 2; R *= 4 } if (R < 8388608) { sh += 1; R *= 2 }
    V = V * 2 ** sh + readBits(pos, sh); pos += sh
  }
  return {
    letter(c) {
      const off = tOff(c), last = tOff(c + 1) - off, r = Math.floor(R / 256)
      const cdf = i => (i > last ? Infinity : i < 1 ? 0 : tByte(off + i - 1))
      let s = 0, lo = 0, hi = R
      for (const st of [8, 4, 2, 1]) { const v = r * cdf(s + st); if (v <= V) { s += st; lo = v } else hi = Math.min(hi, v) }
      V -= lo; R = hi - lo; norm(); return s
    },
    raw(k) {
      const r = Math.floor(R / 2 ** k), m = 2 ** k - 1
      let q = Math.floor(V / r); q = q * r > V ? q - 1 : q; q = (q + 1) * r <= V ? q + 1 : q; q = Math.min(q, m)
      V -= q * r; R = q < m ? r : R - q * r; norm(); return q
    },
  }
}
const tq = Array.from({ length: 128 }, (_, e) => (at(T0 + Math.floor(e / 3)) >>> (8 * (2 - (e % 3)))) & 255)
const S = at(9) / 4096
S4096 = at(9)
function decodePlane(sl0, w, h, q0, tw, th, p, modesFrom) { // -> { rec, modes }
  const bw = w / 8, bh = h / 8, rec = new Int32Array(w * h), modes = modesFrom ? modesFrom : new Int8Array(bw * bh)
  for (let by = 0; by < bh; by++) {
    const d = rangeDecoder(at(1024 + sl0 + by)); let prevN = 0
    for (let bx = 0; bx < bw; bx++) {
      if (!modesFrom) {
        const mpm = bx % tw > 0 ? modes[by * bw + bx - 1] : 0, l = d.letter(p)
        modes[by * bw + bx] = l === 0 ? mpm : l - 1 < mpm ? l - 1 : l
      }
      let dA = 0
      if (p > 0 && modes[by * bw + bx] === 8) dA = A8[d.letter(142 + p)]
      const dql = new Float64Array(64)
      const dcC = d.letter(2 + p), dv = BASE[dcC] + d.raw(EXT[dcC])
      dql[0] = (dv % 2 ? (dv + 1) / 2 : -dv / 2) * tq[q0] * S
      let n = d.letter(cN(p, prevN)); if (ESC && n === 15) n += d.raw(6); prevN = n
      let last = 0
      for (let j = 0; j < n; j++) {
        const rem = n - j, rc = d.letter(cRun(p, last, rem)), lc = d.letter(cLev(p, Math.min(last + BASE[rc] + 1, 63), rem))
        const u = d.raw(EXT[rc] + EXT[lc] + 1), sign = u % 2, rest = Math.floor(u / 2)
        const a = BASE[lc] + (rest % 2 ** EXT[lc]), k = last + BASE[rc] + Math.floor(rest / 2 ** EXT[lc]) + 1
        dql[ZZ[k]] = (sign ? -(a + 1) : a + 1) * tq[q0 + ZZ[k]] * S; last = k
      }
      const c = neighbours(rec, w, bx, by, tw, th), m = modes[by * bw + bx]
      if (m === 8) { cflAC(bx, by); CFL_A = dA }
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) rec[(by * 8 + y) * w + bx * 8 + x] = clamp(Math.round(idctAt(dql, x, y) + predictAt(m, c, x, y)), 0, 255)
    }
  }
  return { rec, modes }
}
const ITEMS = new Int32Array(96); let MAXLEV = 0
const LINFO = new Int16Array(160 * 96), CINFO = new Int16Array(80 * 48)
/** the entries of a block: dql[zz[k]] = level x quantiser x S; returns n */
function readEntries(d, lv, prevN, ctxN, ctxRun, ctxLev, kMax) {
  let n = d.letter(ctxN(prevN)); if (ESC && n === 15) n += d.raw(kMax > 63 ? 8 : 6)
  let last = 0
  for (let j = 0; j < n; j++) {
    const rem = n - j, rc = d.letter(ctxRun(last, rem)), lc = d.letter(ctxLev(Math.min(last + BASE[rc] + 1, kMax), rem))
    const u = d.raw(EXT[rc] + EXT[lc] + 1), sign = u % 2, rest = Math.floor(u / 2)
    const a = BASE[lc] + (rest % 2 ** EXT[lc]), k = last + BASE[rc] + Math.floor(rest / 2 ** EXT[lc]) + 1
    lv[k] = sign ? -(a + 1) : a + 1; last = k; MAXLEV = Math.max(MAXLEV, a + 1)
  }
  return n
}
const unsem = dv => (dv % 2 ? (dv + 1) / 2 : -dv / 2)
function decodeLuma() {
  const w = CW, rec = new Int32Array(w * CH), modes = new Int8Array(160 * 96), parts = new Int8Array(80 * 48)
  const Q16d = q16of(tq.slice(0, 64)), o = new Float64Array(256)
  for (let sy = 0; sy < 48; sy++) {
    const d = rangeDecoder(at(1024 + sy)); let prevN = 0
    for (let sx = 0; sx < 80; sx++) {
      const part = PART ? d.letter(cPart(sx % 20 > 0 ? parts[sy * 80 + sx - 1] : 0)) : 1
      parts[sy * 80 + sx] = part
      if (part === 0) {
        const mpm = sx % 20 > 0 ? modes[2 * sy * 160 + 2 * sx - 1] : 0, l = d.letter(CM16), m = lumaMode(l, mpm)
        CUR_D = DELTA && isDir(m) ? d.letter(CDELTA) - 2 : 0
        const lv = new Int32Array(256), dcC = d.letter(CDC16)
        lv[0] = unsem(BASE[dcC] + d.raw(EXT[dcC]))
        prevN = readEntries(d, lv, prevN, cN16, cRun16, cLev16, 255); ITEMS[sy] += 1 + prevN; MAXLEV = Math.max(MAXLEV, Math.abs(lv[0]))
        const c = neighbours16(rec, w, sx, sy)
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pr16[y * 16 + x] = predict16(m, c, x, y)
        recon(lv, ZZ16, Q16d, 16, pr16, rs16)
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) rec[(sy * 16 + y) * w + sx * 16 + x] = rs16[y * 16 + x]
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { modes[(2 * sy + j) * 160 + 2 * sx + i] = m; LINFO[(2 * sy + j) * 160 + 2 * sx + i] = m + 17 * (CUR_D + 2) }
      } else for (const [i, j, noTR] of SUBS) {
        const bx = 2 * sx + i, by = 2 * sy + j
        const mpm = bx % 40 > 0 ? modes[by * 160 + bx - 1] : 0, l = d.letter(0), m = lumaMode(l, mpm)
        CUR_D = DELTA && isDir(m) ? d.letter(CDELTA) - 2 : 0
        modes[by * 160 + bx] = m; LINFO[by * 160 + bx] = m + 17 * (CUR_D + 2) + 289
        const lv = new Int32Array(64), dcC = d.letter(2)
        lv[0] = unsem(BASE[dcC] + d.raw(EXT[dcC]))
        prevN = readEntries(d, lv, prevN, pn => cN(0, pn), (la, r) => cRun(0, la, r), (k, r) => cLev(0, k, r), 63); ITEMS[sy] += 1 + prevN; MAXLEV = Math.max(MAXLEV, Math.abs(lv[0]))
        const c = neighbours(rec, w, bx, by, 40, 8, noTR)
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pr[y * 8 + x] = predictAt(m, c, x, y)
        recon(lv, ZZ, tq, 8, pr, rs)
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) rec[(by * 8 + y) * w + bx * 8 + x] = rs[y * 8 + x]
      }
    }
  }
  return { rec }
}
const dY = decodeLuma()
LUMA = dY.rec
function decodeChroma() {
  CUR_D = 0
  const w = 640, recs = [new Int32Array(w * 384), new Int32Array(w * 384)], modes = new Int8Array(80 * 48), parts = new Int8Array(40 * 24)
  const tqc = tq.slice(64), Q16d = q16of(tqc), o = new Float64Array(256)
  for (const p of [1, 2]) {
    const rec = recs[p - 1]
    for (let sy = 0; sy < 24; sy++) {
      const d = rangeDecoder(at(1024 + 48 + (p - 1) * 24 + sy)); let prevN = 0
      for (let sx = 0; sx < 40; sx++) {
        if (p === 1) parts[sy * 40 + sx] = PARTC ? d.letter(cPart(sx % 10 > 0 ? parts[sy * 40 + sx - 1] : 0) + OC) : 1
        if (parts[sy * 40 + sx] === 0) {
          if (p === 1) {
            const mpm = sx % 10 > 0 ? modes[2 * sy * 80 + 2 * sx - 1] : 0, l = d.letter(CM16 + OC), m = l === 0 ? mpm : l - 1 < mpm ? l - 1 : l
            for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) modes[(2 * sy + j) * 80 + 2 * sx + i] = m
          }
          const m = modes[2 * sy * 80 + 2 * sx]
          if (m === 8) { CFL_A = A8[d.letter(142 + p)]; cflAC16(sx, sy) }
          const lv = new Int32Array(256), dcC = d.letter(CDC16 + OC)
          lv[0] = unsem(BASE[dcC] + d.raw(EXT[dcC]))
          prevN = readEntries(d, lv, prevN, pn => cN16(pn) + OC, (la, r) => cRun16(la, r) + OC, (k, r) => cLev16(k, r) + OC, 255); ITEMS[24 + 24 * p + sy] += 1 + prevN; MAXLEV = Math.max(MAXLEV, Math.abs(lv[0]))
          const c = neighbours16(rec, w, sx, sy, 10, 2)
          for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pr16[y * 16 + x] = predict16(m, c, x, y)
          recon(lv, ZZ16, Q16d, 16, pr16, rs16)
          for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) rec[(sy * 16 + y) * w + sx * 16 + x] = rs16[y * 16 + x]
        } else for (const [i, j, noTR] of SUBS) {
          const bx = 2 * sx + i, by = 2 * sy + j
          if (p === 1) {
            const mpm = bx % 20 > 0 ? modes[by * 80 + bx - 1] : 0, l = d.letter(1)
            modes[by * 80 + bx] = l === 0 ? mpm : l - 1 < mpm ? l - 1 : l
          }
          const m = modes[by * 80 + bx], dA = m === 8 ? A8[d.letter(142 + p)] : 0
          const lv = new Int32Array(64), dcC = d.letter(2 + p)
          lv[0] = unsem(BASE[dcC] + d.raw(EXT[dcC]))
          prevN = readEntries(d, lv, prevN, pn => cN(p, pn), (la, r) => cRun(p, la, r), (k, r) => cLev(p, k, r), 63); ITEMS[24 + 24 * p + sy] += 1 + prevN; MAXLEV = Math.max(MAXLEV, Math.abs(lv[0]))
          const c = neighbours(rec, w, bx, by, 20, 4, noTR)
          if (m === 8) { cflAC(bx, by); CFL_A = dA }
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pr[y * 8 + x] = predictAt(m, c, x, y)
          recon(lv, ZZ, tqc, 8, pr, rs)
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) rec[(by * 8 + y) * w + bx * 8 + x] = rs[y * 8 + x]
        }
      }
    }
  }
  dCoModes = [...modes].map((m, i) => m + 289 * parts[Math.floor(i / 160) * 40 + Math.floor((i % 80) / 2)])
  return recs
}
let dCoModes = []
const [dCoRec, dCgRec] = decodeChroma(), dCo = { rec: dCoRec }, dCg = { rec: dCgRec }
let mism = 0
for (const [a, b] of [[dY.rec, enc.y.rec], [dCo.rec, enc.c.recs[0]], [dCg.rec, enc.c.recs[1]]]) for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) mism++
const up = (p, x, y) => { const fx = clamp(x / 2 - 0.25, 0, 639), fy = clamp(y / 2 - 0.25, 0, 383), x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, 639), y1 = Math.min(y0 + 1, 383), ax = fx - x0, ay = fy - y0
  return (p[y0 * 640 + x0] * (1 - ax) + p[y0 * 640 + x1] * ax) * (1 - ay) + (p[y1 * 640 + x0] * (1 - ax) + p[y1 * 640 + x1] * ax) * ay }
const rgb = Buffer.alloc(CW * PH * 3); let err = 0
for (let y = 0; y < PH; y++) for (let x = 0; x < CW; x++) {
  const yy = dY.rec[y * CW + x], o = up(dCo.rec, x, y) - 128, g = up(dCg.rec, x, y) - 128, i = (y * CW + x) * 3
  rgb[i] = clamp(Math.round(yy + o - g), 0, 255); rgb[i + 1] = clamp(Math.round(yy + g), 0, 255); rgb[i + 2] = clamp(Math.round(yy - o - g), 0, 255)
  for (let c = 0; c < 3; c++) { const d = rgb[i + c] - pic[i + c]; err += d * d }
}
const psnrOf = img => { let e = 0; for (let i = 0; i < CW * PH * 3; i++) e += (img[i] - pic[i]) ** 2; return 10 * Math.log10((255 * 255) / (e / (CW * PH * 3))) }
const psnr = psnrOf(rgb)

// --- post-filters: the deblock, then a luma CDEF (presets chosen here, written to words 1120..1151 and read back) ------
// All values are dyadic rationals of < 24 bits, so float32 holds them exactly; rounding is floor(v + 0.5) (Math.round).
const H = PH, W = CW
function deb(p3, p2, p1, p0, q0, q1, q2, q3, k, a, bt, tc) {
  const self = [p3, p2, p1, p0, q0, q1, q2, q3][k + 4], d = q0 - p0
  const flat = Math.max(Math.abs(p2 - p3), Math.abs(p1 - p2), Math.abs(p0 - p1), Math.abs(q1 - q0), Math.abs(q2 - q1), Math.abs(q3 - q2))
  const off = k < 0 ? (2 * (k + 4) + 1) / 16 : -(2 * (3 - k) + 1) / 16
  const dl = clamp((d * 4 + p1 - q1 + 4) / 8, -tc, tc)
  const weak = k > -1.5 && k < 0.5 ? (k < -0.5 ? p0 + dl : q0 - dl) : self
  return Math.abs(d) >= a ? self : flat < bt ? self + d * off : weak
}
const ql = (at(9) * tq[0]) / 32768, qc = (at(9) * tq[64]) / 32768
const ycc = (img, i) => [(img[i] + 2 * img[i + 1] + img[i + 2]) / 4, (img[i] - img[i + 2]) / 2, (2 * img[i + 1] - img[i] - img[i + 2]) / 4]
const debLine = (t, k, chroma) => [0, 1, 2].map(c => (c === 0 || chroma) ? deb(...t.map(v => v[c]), k, c ? qc * 4 : ql * 4, c ? qc * 1.5 : ql * 1.5, c ? qc : ql) : t[k + 4][c])
const toRgb = c => [c[0] + c[1] - c[2], c[0] + c[2], c[0] - c[1] - c[2]]
const hp = new Array(W * H)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const m = x % 8, k = m < 4 ? m : m - 8, e = x - k
  if (e < 1 || e > W - 1) { hp[y * W + x] = ycc(rgb, (y * W + x) * 3); continue }
  const t = []; for (let i = -4; i < 4; i++) t.push(ycc(rgb, (y * W + clamp(e + i, 0, W - 1)) * 3))
  hp[y * W + x] = debLine(t, k, e % 16 === 0)
}
const db = Buffer.alloc(W * H * 3)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const m = y % 8, k = m < 4 ? m : m - 8, e = y - k
  let c
  if (e < 1 || e > H - 1) c = hp[y * W + x]
  else { const t = []; for (let i = -4; i < 4; i++) t.push(hp[clamp(e + i, 0, H - 1) * W + x]); c = debLine(t, k, e % 16 === 0) }
  const o = toRgb(c); for (let j = 0; j < 3; j++) db[(y * W + x) * 3 + j] = clamp(Math.round(o[j]), 0, 255)
}
// CDEF (AV1's cdef_find_dir and cdef_filter on Y4 = r + 2g + b, 10-bit style): per 8x8 block a direction and its contrast,
// per pixel primary taps along it and secondary taps at +-45 degrees; per 64x64 unit one of 8 presets (pri 0..15, sec 0 1 2 4)
const DAMP = 8, SECS = [0, 1, 2, 4], UW = 20, UH = Math.ceil(H / 64), NU = UW * UH, BW = W / 8, BH = H / 8
const Y4 = new Int32Array(W * H)
for (let i = 0; i < W * H; i++) Y4[i] = db[i * 3] + 2 * db[i * 3 + 1] + db[i * 3 + 2]
const DIV = [0, 840, 420, 280, 210, 168, 140, 120, 105]
const DIRS = new Int8Array(BW * BH), VARS = new Int32Array(BW * BH)
{
  const P = Array.from({ length: 8 }, () => new Int32Array(15))
  for (let by = 0; by < BH; by++) for (let bx = 0; bx < BW; bx++) {
    P.forEach(p => p.fill(0))
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      const x = (Y4[(by * 8 + i) * W + bx * 8 + j] >> 2) - 128, j2 = j >> 1, i2 = i >> 1
      P[0][i + j] += x; P[1][i + j2] += x; P[2][i] += x; P[3][3 + i - j2] += x
      P[4][7 + i - j] += x; P[5][3 - i2 + j] += x; P[6][j] += x; P[7][i2 + j] += x
    }
    const cost = new Array(8).fill(0)
    for (let i = 0; i < 8; i++) { cost[2] += P[2][i] ** 2; cost[6] += P[6][i] ** 2 }
    cost[2] *= DIV[8]; cost[6] *= DIV[8]
    for (let i = 0; i < 7; i++) { cost[0] += (P[0][i] ** 2 + P[0][14 - i] ** 2) * DIV[i + 1]; cost[4] += (P[4][i] ** 2 + P[4][14 - i] ** 2) * DIV[i + 1] }
    cost[0] += P[0][7] ** 2 * DIV[8]; cost[4] += P[4][7] ** 2 * DIV[8]
    for (let i = 1; i < 8; i += 2) {
      for (let j = 0; j < 5; j++) cost[i] += P[i][3 + j] ** 2
      cost[i] *= DIV[8]
      for (let j = 0; j < 3; j++) cost[i] += (P[i][j] ** 2 + P[i][10 - j] ** 2) * DIV[2 * j + 2]
    }
    let bd = 0; for (let d = 1; d < 8; d++) if (cost[d] > cost[bd]) bd = d
    for (const v of cost) if (v >= 2 ** 31) throw new Error('cdef cost overflow')
    DIRS[by * BW + bx] = bd; VARS[by * BW + bx] = (cost[bd] - cost[(bd + 4) & 7]) >> 10
  }
}
const CD = [[[-1, 1], [-2, 2]], [[0, 1], [-1, 2]], [[0, 1], [0, 2]], [[0, 1], [1, 2]], [[1, 1], [2, 2]], [[1, 0], [2, 1]], [[1, 0], [2, 0]], [[1, 0], [2, -1]]]
const ilog2 = v => 31 - Math.clz32(v)
const constrain = (diff, thr) => {
  if (!thr) return 0
  const sh = Math.max(0, DAMP - ilog2(thr)), ad = Math.abs(diff)
  return Math.sign(diff) * clamp(thr - (ad >> sh), 0, ad)
}
const adjust = (pri, v) => { const i = v >> 6 ? Math.min(ilog2(v >> 6), 12) : 0; return v ? (pri * (4 + i) + 8) >> 4 : 0 }
function cdefAt(x, y, pri, sec) {
  const k = (y >> 3) * BW + (x >> 3), d = DIRS[k], ps = adjust(pri, VARS[k]) << 2, ss = sec << 2, c = Y4[y * W + x]
  if (!ps && !ss) return c
  const pt = (ps >> 2) & 1 ? [3, 3] : [4, 2], st = [2, 1]
  let sum = 0, mx = c, mn = c
  const tap = (dir, kk, sgn, thr, wt) => {
    const yy = y + sgn * CD[dir][kk][0], xx = x + sgn * CD[dir][kk][1]
    if (yy < 0 || yy >= H || xx < 0 || xx >= W) return
    const v = Y4[yy * W + xx]; sum += wt * constrain(v - c, thr); if (v > mx) mx = v; if (v < mn) mn = v
  }
  for (let kk = 0; kk < 2; kk++) for (const sg of [1, -1]) {
    if (ps) tap(d, kk, sg, ps, pt[kk])
    if (ss) { tap((d + 2) & 7, kk, sg, ss, st[kk]); tap((d + 6) & 7, kk, sg, ss, st[kk]) }
  }
  return clamp(c + ((8 + sum - (sum < 0 ? 1 : 0)) >> 4), mn, mx)
}
const withY4 = (out, i, y4) => { const dl = (y4 - Y4[i]) / 4; for (let c = 0; c < 3; c++) out[i * 3 + c] = clamp(Math.round(db[i * 3 + c] + dl), 0, 255) }
{ // the search: each unit's squared error under each of the 64 (pri, sec) pairs, then 8 presets chosen greedily
  const SSE = Array.from({ length: NU }, () => new Float64Array(64))
  for (let u = 0; u < NU; u++) {
    const x0 = (u % UW) * 64, y0 = Math.floor(u / UW) * 64
    for (let y = y0; y < Math.min(H, y0 + 64); y++) for (let x = x0; x < x0 + 64; x++) for (let ci = 0; ci < 64; ci++) {
      const i = y * W + x
      const dl = (cdefAt(x, y, ci >> 2, SECS[ci & 3]) - Y4[i]) / 4; let e = 0
      for (let c = 0; c < 3; c++) e += (clamp(Math.round(db[i * 3 + c] + dl), 0, 255) - pic[i * 3 + c]) ** 2
      SSE[u][ci] += e
    }
  }
  const chosen = [], best = new Float64Array(NU).fill(Infinity)
  while (chosen.length < 8) {
    let bc = -1, bt = Infinity
    for (let ci = 0; ci < 64; ci++) { if (chosen.includes(ci)) continue; let t = 0; for (let u = 0; u < NU; u++) t += Math.min(best[u], SSE[u][ci]); if (t < bt) { bt = t; bc = ci } }
    chosen.push(bc); for (let u = 0; u < NU; u++) best[u] = Math.min(best[u], SSE[u][bc])
  }
  chosen.forEach((ci, i) => { words[1120 + (i >> 2)] |= ci << (6 * (3 - (i & 3))) })
  for (let u = 0; u < NU; u++) {
    let b = 0; for (let i = 1; i < 8; i++) if (SSE[u][chosen[i]] < SSE[u][chosen[b]]) b = i
    words[1122 + (u >> 3)] |= b << (3 * (7 - (u & 7)))
  }
}
const presetAt = i => (at(1120 + (i >> 2)) >>> (6 * (3 - (i & 3)))) & 63
const presetOf = u => presetAt((at(1122 + (u >> 3)) >>> (3 * (7 - (u & 7)))) & 7)
const fin = Buffer.alloc(W * H * 3)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const ci = presetOf((y >> 6) * UW + (x >> 6)); withY4(fin, y * W + x, cdefAt(x, y, ci >> 2, SECS[ci & 3]))
}
const presetList = Array.from({ length: 8 }, (_, i) => presetAt(i)).map(ci => `${ci >> 2}/${SECS[ci & 3]}`).join(' ')
console.log(`PSNR decoded ${psnr.toFixed(3)}, deblocked ${psnrOf(db).toFixed(3)}, cdef (${presetList}) ${psnrOf(fin).toFixed(3)} dB`)
if (process.env.REF) { // planes and pictures for the shader simulator, 8-bit each, in this order
  const u8 = a => Buffer.from(Uint8Array.from(a))
  writeFileSync(process.env.REF, Buffer.concat([u8(dY.rec), u8(dCo.rec), u8(dCg.rec), rgb, db, fin, Buffer.from(DIRS.buffer), Buffer.from(VARS.buffer)]))
  writeFileSync(process.env.REF + '.json', JSON.stringify({ order: ['Y 1280x768', 'Co 640x384', 'Cg 640x384', 'rgb 1280x760x3', 'deblocked', 'final', 'cdef dirs int8 160x95', 'cdef vars int32 160x95'], linfo: [...LINFO], cmodes: [...dCoModes] }))
}
if (process.env.WORDS) writeFileSync(process.env.WORDS, JSON.stringify(words))
{ // letters per slice: sizes the decoder's per-frame throughput
  const n = []; eachSymbol(enc, () => n[n.length - 1]++, () => {}, () => n.push(0))
  const st = a => `max ${Math.max(...a)}, mean ${(a.reduce((x, v) => x + v, 0) / a.length).toFixed(0)}`
  console.log(`letters per slice: Y ${st(n.slice(0, 48))}; Co ${st(n.slice(48, 72))}; Cg ${st(n.slice(72))}`)
  const it = [...ITEMS]; console.log(`items (headers + entries) per slice: Y ${st(it.slice(0, 48))}; Co ${st(it.slice(48, 72))}; Cg ${st(it.slice(72))}; max |level| ${MAXLEV}, max |level x q x s4096| ${MAXLEV * Math.max(...tq) * at(9)} (int limit ${2 ** 31})`)
  if (Math.max(...it) > 2048) throw new Error('a slice has more than 2048 items')
}
if (previewPath) {
  writeFileSync(previewPath + '.rgb', fin)
  // the partitions (0 = one 16x16), for partition-aware post-filters: luma 80 x 48, chroma 40 x 24 superblocks
  writeFileSync(previewPath + '.parts.json', JSON.stringify({ y: enc.y.sbs.map(b => b.part), c: enc.c.sbs.map(b => b.part) }))
  const raw = Buffer.alloc((CW * 3 + 1) * PH)
  for (let y = 0; y < PH; y++) fin.copy(raw, y * (CW * 3 + 1) + 1, y * CW * 3, (y + 1) * CW * 3)
  const crc = b => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1 } return ~c >>> 0 }
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const hdr = Buffer.alloc(13); hdr.writeUInt32BE(CW, 0); hdr.writeUInt32BE(PH, 4); hdr[8] = 8; hdr[9] = 2
  writeFileSync(previewPath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', hdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

// the loading preview (thumb.mjs) in the words the codec leaves free
for (const [w, v] of Object.entries(thumbWords(fin, CW, PH))) { if (words[+w]) throw new Error(`word ${w} is in use`); words[+w] = v }
// --- Svg ---------------------------------------------------------------------------------------------------------
const step = +stepArg / 1000, gap = +gapArg, dur = +(MOMENTS * step).toFixed(3)
const hex = v => '#' + v.toString(16).padStart(6, '0')
const cell = (x, y, list, first) =>
  `<path d="M${x} ${y}h1v1H${x}"><animate ${first ? `id="c" begin="0s;c.end+${gap}s"` : 'begin="c.begin"'} ` +
  `attributeName="fill" dur="${dur}s" calcMode="discrete" repeatCount="3" values="${list.map(hex).join(';')}"/></path>`
let body = cell(0, 8, Array.from({ length: MOMENTS }, (_, k) => 0xa50000 + k), true)
for (let i = 0; i < CELLS; i++) body += cell(i % 16, Math.floor(i / 16), Array.from({ length: MOMENTS }, (_, k) => words[k * CELLS + i]))
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90" preserveAspectRatio="none" shape-rendering="crispEdges">` +
  `<rect width="160" height="90" fill="${hex((mean[0] << 16) | (mean[1] << 8) | mean[2])}"/>${body}</svg>`
writeFileSync(outPath, svg)
{ const h = new Array(17).fill(0); enc.y.sbs.forEach(sb => { if (sb.part === 0) h[sb.b.mode] += 4; else sb.subs.forEach(b => h[b.mode]++) }); console.log('luma modes (8x8 units, 0..16): ' + h.join(' ')) }
console.log('chroma modes (Co blocks, 0..8): ' + modeStats(enc) + `; luma 16x16 superblocks ${enc.y.n16} of 3840, chroma ${enc.c.n16} of 960, luma bits ${enc.y.bits.toFixed(0)}`)
console.log(`s ${s.toFixed(4)}, stream ${bitsOut.length} of ${STREAM_BITS} bits, decode mismatches ${mism}, PSNR ${psnr.toFixed(2)} dB; ` +
  `${outPath.replace(/^.*[\\/]/, '')}: ${svg.length} chars (left ${131072 - svg.length})`)
