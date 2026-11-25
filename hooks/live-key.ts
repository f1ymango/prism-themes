// The live wallpaper player for a keyframe sent as data (format KA2): the Svg draws only a flat colour and a 16 x 8
// grid of SMIL cells (+ a clock) in its top left (viewBox 160 x 90, stretched). The shader collects 110 moments x 128
// words of 24 bits, decodes the picture from them once, then moves it with the motion words, as hooks/live.ts does.
// The converter is notes/live-converter/ka2-enc.mjs; its header gives the word layout. In short: 16x16 superblocks
// (one 16x16 block or four 8x8 in z-order), YCoCg with chroma halved, intra prediction (DC, V, H, Paeth, smooth, two
// diagonals, gradient, chroma-from-luma, 8 more luma angles, +-2 angle deltas), an integer inverse DCT, range-coded
// letters with static per-picture tables; then a deblock and a luma CDEF. Every step is integer (or exact dyadic)
// arithmetic, so the GPU reproduces the converter's picture bit for bit.
// Stages (ctl row 14, x 0; see ST_*): 0 collecting and decoding (D: one range decoder per slice = superblock row, K letters a
// frame; P keeps what each step of each slice produced: block headers and coefficient entries),
// 1..104 luma rebuild (tiles of 20 x 4 superblocks, a superblock diagonal i + 2j of every tile per 4 frames, one
// z-order sub-block a frame: CF gathers the coefficients, TH the row transform, W the column transform + prediction,
// pic keeps the planes), 105..152 chroma rebuild (tiles of 10 x 2), 153..164 paint a 64-row band a frame from the
// bottom up (the chroma planes sit in the top rows, so they outlast their use), 154..177 deblock a 32-row window a
// frame, 178 CDEF directions (CD), 179..202 CDEF a 32-row band a frame from the bottom up, 203 done. Until a band is painted the
// window shows the Svg's flat colour.
import { abs, buffer, clamp, cos, floor, int, max, min, mod, picture, range, scene, shader, signed, sin, size, still, time, unsigned, values, vec2, vec3, vec4, type Buffer, type int as Int } from 'claude-code/shader'

// /prism livedebug: 1 draws the decoder's progress over the top of the window
const v = values({ debug: [0, 1] })

const CELLS = 128
const MOMENTS = 110
const WORDS = 14080
const T0 = 1216
// symbol tables: each context's offset (12 bits, 2 a word, contexts 0..252), then the bytes
const CT0 = 1259
const CB0 = 1386
// the coded picture: 1280 x 768, of which the top 760 rows show
const CH = 768
const PH = 760
const BIG = 1000000000
// stages
const ST_C0 = 105
const ST_P0 = 153
const ST_CD = 178
const ST_F0 = 179
const ST_DONE = 203
// slice decoders: K letters a frame; D rows 0-6 state, then a row per two steps (their items)
const K = 32
const SLOT0 = 7
const DROWS = SLOT0 + K / 2
// decoder phases
const PART = 0
const MODE = 1
const DELTA = 2
const ALPHA = 3
const DCP = 4
const NP = 5
const RUN = 6
const LEV = 7
const BEGIN = 8
const DONE = 9

const cellAt = (i: number) => vec2((mod(i, 16) + 0.5) / 160, 1 - (floor(i / 16) + 0.5) / 90)
const word = (c: vec4): Int =>
  int(int(int(floor(c.r * 255 + 0.5)) << 16) | int(int(floor(c.g * 255 + 0.5)) << 8) | int(floor(c.b * 255 + 0.5)))
/** an 8-bit lane as its whole number 0..255 */
const byte = (x: number) => floor(x * 255 + 0.5)

// the words, a row a moment; alpha 1 once seen
const acc: Buffer = buffer({ size: [128, 110], filter: 'nearest' }, q => {
  const old = acc.at(q.cell)
  const clock = scene.sample(vec2(0.5 / 160, 1 - 8.5 / 90))
  const ours = floor(clock.r * 255 + 0.5) === 165
  const now = floor(clock.g * 255 + 0.5) * 256 + floor(clock.b * 255 + 0.5)
  const s = scene.sample(cellAt(q.cell.x))
  return ours && now === q.cell.y && old.a < 0.5 ? vec4(s.x, s.y, s.z, 1) : old
})
const at = (s: number): Int => word(acc.at(vec2(s - floor(s / CELLS) * CELLS, floor(s / CELLS))))
/** a mod n for whole numbers a, n, safe from a GPU's inexact division (a / n can land just under a whole number) */
function imod(a: number, n: number): number {
  return a - n * floor((a + 0.5) / n)
}
// control: rows 0..13 the words seen in each 8 x 8 cells of acc; row 14: x 0 the stage, x 1 ready
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
  const marks = signed(at(0)) === 5263948 && signed(at(8)) === 4931890
  return vec4(n > WORDS - 0.5 && marks ? 1 : 0, n, 0, 1)
}
function stageNext(): vec4 {
  const s = ctl.at(vec2(0, 14)).x
  // every slice decoded (and its last item out)
  // written out over a list, numbers multiplied: as a for loop keeping a flag in a let, Desktop's compiled shader read
  // "all done" at once and the rebuild started with the decode (0.10.28-0.10.31)
  let all = 1
  for (const sl of range(96)) all = all * (D.at(vec2(sl, 0)).w > DONE - 0.5 ? 1 : 0) * (D.at(vec2(sl, 5)).w < 0.5 ? 1 : 0)
  return vec4(s > ST_DONE - 0.5 ? s : s > 0.5 ? s + 1 : all > 0.5 && going() ? 1 : 0, 0, 0, 1)
}
const ctl: Buffer = buffer({ size: [16, 15], float: 32, filter: 'nearest' }, q => {
  if (q.cell.y < 13.5) return vec4(seenCell(q.cell.x, q.cell.y), 0, 0, 1)
  if (q.cell.x > 1.5) return vec4(0)
  return q.cell.x > 0.5 ? readyNow() : stageNext()
})
const stageNow = () => ctl.at(vec2(0, 14)).x
const done = () => stageNow() > ST_DONE - 0.5
const going = () => ctl.at(vec2(1, 14)).x > 0.5 && !done()
const rebuilding = () => stageNow() > 0.5 && stageNow() < ST_P0 - 0.5
const lumaPhase = () => stageNow() < ST_C0 - 0.5
const rstepAll = () => (lumaPhase() ? stageNow() - 1 : stageNow() - ST_C0)
const sbStep = () => floor(rstepAll() / 4)
const subNow = () => mod(rstepAll(), 4)
// 64-row band b is painted at stage 164 - b, 32-row window w deblocked at 177 - w, 32-row band b CDEF'd at 202 - b
const painting = () => stageNow() > ST_P0 - 0.5 && stageNow() < ST_P0 + 11.5
const deblocking = () => stageNow() > ST_P0 + 0.5 && stageNow() < ST_CD - 0.5
const win = () => ST_CD - 1 - stageNow()
const cdefing = () => stageNow() > ST_F0 - 0.5 && stageNow() < ST_DONE - 0.5
const fband = () => ST_DONE - 1 - stageNow()

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
/** 2^e, e an integer 0..23 */
function qPow(e: number): number {
  let p = 1
  for (let j = 0; j < 23; j++) p = j < e - 0.5 ? p * 2 : p
  return p
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
/** quantiser t of the picture's tables (0-63 luma, 64-127 chroma, raster order) */
function quant(t: number): number {
  const w = signed(at(T0 + floor((t + 0.5) / 3)))
  const r = imod(t, 3)
  return mod(floor(w / (r < 0.5 ? 65536 : r < 1.5 ? 256 : 1)), 256)
}
// context buckets: the left block's entry count, the zigzag index before a run, a level's zigzag index, entries left
const nBk = (x: number) => (x > 0.5 ? 1 : 0) + (x > 2.5 ? 1 : 0) + (x > 5.5 ? 1 : 0)
const rBk = (x: number) => (x > 0.5 ? 1 : 0) + (x > 2.5 ? 1 : 0) + (x > 5.5 ? 1 : 0) + (x > 9.5 ? 1 : 0) + (x > 19.5 ? 1 : 0)
const kBk = (x: number) =>
  (x > 1.5 ? 1 : 0) + (x > 2.5 ? 1 : 0) + (x > 4.5 ? 1 : 0) + (x > 7.5 ? 1 : 0) + (x > 11.5 ? 1 : 0) + (x > 19.5 ? 1 : 0) + (x > 31.5 ? 1 : 0)
const rBk16 = (x: number) => (x > 0.5 ? 1 : 0) + (x > 3.5 ? 1 : 0) + (x > 9.5 ? 1 : 0) + (x > 23.5 ? 1 : 0) + (x > 47.5 ? 1 : 0) + (x > 95.5 ? 1 : 0)
const kBk16 = (x: number) =>
  (x > 1.5 ? 1 : 0) + (x > 3.5 ? 1 : 0) + (x > 7.5 ? 1 : 0) + (x > 15.5 ? 1 : 0) + (x > 31.5 ? 1 : 0) + (x > 63.5 ? 1 : 0) + (x > 127.5 ? 1 : 0)
const lBk = (x: number) => (x > 1.5 ? 1 : 0) + (x > 2.5 ? 1 : 0)
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
// The tables unpacked: context c (y), letter i (x): x where the letter starts (of 256); past the last letter, 1e9.
// Constants in y, z, w: row 0 a value class's first value, its low bits, 2^i (i 0..23); row 1 the 8-point DCT basis
// round(2048 cos(i pi / 16)), the 16-point round(4096 sqrt(1/8) cos(i pi / 32)), round(64 tan(3.75 i degrees));
// row 2 the chroma-from-luma alphas (eighths); rows 3 + x (x 0..15) the inverse DCT basis at point x, frequency i:
// y 16-point, z 8-point.
const BAS16 = [1441, 1420, 1386, 1338, 1277, 1204, 1119, 1024, 919, 805, 683, 554, 420, 283, 142, 0]
const BAS8 = [2048, 2009, 1892, 1703, 1448, 1138, 784, 400, 0]
const TAN0 = [0, 4, 8, 13, 17, 22, 27, 32, 37, 43, 49, 56]
const TAN1 = [64, 73, 83, 96, 111, 130, 155, 189, 239, 322, 486, 976]
const ALPHAS = [-16, -12, -8, -6, -4, -3, -2, -1, 1, 2, 3, 4, 6, 8, 12, 16]
/** the integer inverse DCT basis (4096 scale), point x, frequency u */
function basis(N: number, x: number, u: number): number {
  const m = mod((2 * x + 1) * u, 4 * N)
  const i = m < N + 0.5 ? m : m < 2 * N + 0.5 ? 2 * N - m : m < 3 * N + 0.5 ? m - 2 * N : 4 * N - m
  const b = (N > 8.5 ? BAS16[clamp(i - 1, 0, 15)]! : BAS8[min(i, 8)]!) * (m > N + 0.5 && m < 3 * N + 0.5 ? -1 : 1)
  return u < 0.5 ? (N > 8.5 ? 1024 : 1448) : b
}
const Q: Buffer = buffer({ size: [24, 256], float: 32, filter: 'nearest' }, q => {
  const i = q.cell.x
  const c = q.cell.y
  const h = floor(i / 2)
  const first = i < 3.5 ? i : (2 + mod(i, 2)) * qPow(h - 1)
  const extra = i < 3.5 ? 0 : i > 14.5 ? 13 : h - 1
  const k0 = vec3(first, extra, qPow(i))
  const k1 = vec3(i < 8.5 ? BAS8[min(i, 8)]! : 0, i > 0.5 && i < 16.5 ? BAS16[clamp(i - 1, 0, 15)]! : 0, i < 11.5 ? TAN0[min(i, 11)]! : TAN1[clamp(i - 12, 0, 11)]!)
  const k2 = vec3(ALPHAS[min(i, 15)]!, 0, 0)
  const bx = c - 3
  const k3 = vec3(basis(16, bx, i), bx < 7.5 && i < 7.5 ? basis(8, bx, i) : 0, 0)
  const k = c < 0.5 ? k0 : c < 1.5 ? k1 : c < 2.5 ? k2 : c < 18.5 ? k3 : vec3(0)
  if (!going() || i > 15.5 || c > 251.5) return vec4(0, k.x, k.y, k.z)
  const off = tOff(c)
  const last = tOff(c + 1) - off
  return vec4(i < 0.5 ? 0 : i > last + 0.5 ? BIG : tByte(off + i - 1), k.x, k.y, k.z)
})
const BASEof = (i: number) => Q.at(vec2(i, 0)).y
const EXTof = (i: number) => Q.at(vec2(i, 0)).z
const POWof = (i: number) => Q.at(vec2(i, 0)).w
const T64of = (i: number) => Q.at(vec2(clamp(i, 0, 23), 1)).w
/** one letter of context c (the largest s with floor(R / 256) * cdf(s) <= V) */
function letter(d: vec4, c: number): vec4 {
  const r = floor(d.y / 256)
  let s = 0
  let lo = 0
  let hi = d.y
  for (const k of range(4)) {
    const i = s + (k < 0.5 ? 8 : k < 1.5 ? 4 : k < 2.5 ? 2 : 1)
    const x = r * Q.at(vec2(i, c)).x
    const ok = x - d.x < 0.5
    s = ok ? i : s
    lo = ok ? x : lo
    hi = ok ? hi : min(hi, x)
  }
  return renorm(d.x - lo, hi - lo, d.z, s)
}
/** k (0..23) equally likely bits */
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

// --- decoding, once every word is in -------------------------------------------------------------------------------
// The slice decoders, a column each (Y superblock rows 0-47, Co 48-71, Cg 72-95), a letter (+ its raw bits) a step.
// State rows: 0 (V, R, next bit, phase), 1 (superblock, sub-block, partition, left partition), 2 (left superblock's
// right-column modes top and bottom, the last block's mode, this block's mode), 3 (left entry count, n, entries read,
// last zigzag index), 4 (run class, delta / alpha letter, DC level, Cg: the P texel of Co's next header), 5 (steps
// recorded, steps at the frame's start, started, DC pending), 6 (the last item: key, value; the pending DC's key).
// Row SLOT0 + r: this frame's steps 2r and 2r + 1, each an item (key, value) or, if the step made none, the last item again (keys
// never fall along a slice). Items: a block header (key = (superblock * 4 + sub-block) * 512, value = mode + 17 *
// delta/alpha letter + 289 * partition), then its DC (key + 1) and its entries (key + 1 + zigzag index, level). Cg
// has no partition or mode letters: it reads Co's headers from P as they arrive.
const D: Buffer = buffer({ size: [96, DROWS], float: 32, filter: 'nearest' }, q => {
  const old = D.at(q.cell)
  if (!going()) return done() ? old : vec4(0)
  const sl = q.cell.x
  const row = q.cell.y
  const my = 2 * (row - SLOT0)
  const s0 = D.at(vec2(sl, 0))
  const s1 = D.at(vec2(sl, 1))
  const s2 = D.at(vec2(sl, 2))
  const s3 = D.at(vec2(sl, 3))
  const s4 = D.at(vec2(sl, 4))
  const s5 = D.at(vec2(sl, 5))
  const s6 = D.at(vec2(sl, 6))
  const plane = sl < 47.5 ? 0 : sl < 71.5 ? 1 : 2
  const nsb = plane < 0.5 ? 80 : 40
  const tws = plane < 0.5 ? 20 : 10
  const c16b = plane < 0.5 ? 0 : 53
  const fresh = s5.z < 0.5
  const p0 = signed(at(1024 + sl))
  let V = fresh ? bitsAt(p0, 24) : s0.x
  let R = fresh ? 16777215 : s0.y
  let pos = fresh ? p0 + 24 : s0.z
  let ph = fresh ? (plane > 1.5 ? BEGIN : PART) : s0.w
  let sx = s1.x
  let sub = s1.y
  let part = s1.z
  let lp = s1.w
  let mL0 = s2.x
  let mL1 = s2.y
  let lastM = s2.z
  let mode = s2.w
  let prevN = s3.x
  let n = s3.y
  let j = s3.z
  let last = s3.w
  let rc = s4.x
  let sel = s4.y
  let dcL = s4.z
  let cp = s4.w
  let pend = s5.w
  let lk = fresh ? -1 : s6.x
  let lv = s6.y
  let pk = s6.z
  const pc0 = s5.x
  const active = ph < DONE - 0.5 || pend > 0.5
  const coPc0 = plane > 1.5 ? D.at(vec2(sl - 24, 5)).y : 0
  let o = vec4(0)
  for (let k = 0; k < K; k++) {
    let go = ph < BEGIN + 0.5 ? 1 : 0
    // Cg: a block starts with its Co block's header (partition, mode), looked for along Co's row of P
    if (ph > BEGIN - 0.5 && ph < BEGIN + 0.5) {
      const tgt = (sx * 4 + sub) * 512
      const hd = P.at(vec2(cp, sl - 24))
      const okx = 2 * cp < coPc0 - 0.5 && abs(hd.x - tgt) < 0.5
      const okz = 2 * cp + 1 < coPc0 - 0.5 && abs(hd.z - tgt) < 0.5
      if (okx || okz) {
        const info = okx ? hd.y : hd.w
        part = sub < 0.5 ? floor((info + 0.5) / 289) : part
        mode = imod(info, 17)
        ph = mode > 7.5 ? ALPHA : DCP
      } else {
        cp = 2 * cp + 1 < coPc0 - 0.5 ? cp + 1 : cp
        go = 0
      }
    }
    let ek = lk
    let ev = lv
    if (pend > 0.5) {
      ek = pk
      ev = dcL
      pend = 0
    }
    if (go > 0.5) {
      const p = ph
      const big = part < 0.5
      const left = imod(sx, tws) > 0.5
      const rem = n - j
      const kk0 = min(last + BASEof(rc) + 1, big ? 255 : 63)
      const ctx = p < 0.5 ? 145 + c16b + (left ? lp : 0)
        : p < 1.5 ? (big ? 147 + c16b : plane)
        : p < 2.5 ? 251
        : p < 3.5 ? 142 + plane
        : p < 4.5 ? (big ? 148 + c16b : 2 + plane)
        : p < 5.5 ? (big ? 149 + c16b : 5 + 4 * plane) + nBk(prevN)
        : p < 6.5 ? (big ? 153 + c16b + rBk16(last) * 3 : 17 + 18 * plane + rBk(last) * 3) + lBk(rem)
        : (big ? 174 + c16b + kBk16(kk0) * 3 : 71 + 24 * plane + kBk(kk0) * 3) + lBk(rem)
      const dl = letter(vec4(V, R, pos, 0), ctx)
      const l = dl.w
      const rk = p > 3.5 && p < 4.5 ? EXTof(l) : p > 4.5 && p < 5.5 ? (l > 14.5 ? (big ? 8 : 6) : 0) : p > 6.5 ? EXTof(rc) + EXTof(l) + 1 : 0
      const du = raw(dl, rk)
      V = du.x
      R = du.y
      pos = du.z
      const u = du.w
      let fin = 0
      const bk = (sx * 4 + sub) * 512
      if (p < 0.5) {
        part = l
        lp = l
        ph = MODE
      } else if (p < 1.5) {
        const mp = (sub > 0.5 && sub < 1.5) || sub > 2.5 ? lastM : left ? (sub > 1.5 ? mL1 : mL0) : 0
        const mi = mp > 8.5 ? mp - 1 : mp
        const r0 = l - 1 < mi - 0.5 ? l - 1 : l
        const ml = l < 0.5 ? mp : r0 > 7.5 ? r0 + 1 : r0
        const mc = l < 0.5 ? mp : l - 1 < mp - 0.5 ? l - 1 : l
        mode = plane < 0.5 ? ml : mc
        sel = 0
        const dir = mode > 8.5 || (mode > 0.5 && mode < 2.5)
        ph = plane < 0.5 ? (dir ? DELTA : DCP) : mode > 7.5 ? ALPHA : DCP
      } else if (p < 3.5) {
        sel = l
        ph = DCP
      } else if (p < 4.5) {
        const dv = BASEof(l) + u
        dcL = mod(dv, 2) > 0.5 ? (dv + 1) / 2 : 0 - dv / 2
        ph = NP
      } else if (p < 5.5) {
        n = l > 14.5 ? 15 + u : l
        prevN = n
        j = 0
        last = 0
        ek = bk
        ev = mode + 17 * sel + 289 * part
        pend = 1
        pk = bk + 1
        ph = RUN
        fin = n < 0.5 ? 1 : 0
      } else if (p < 6.5) {
        rc = l
        ph = LEV
      } else {
        const pw = POWof(EXTof(l))
        const rest = floor(u / 2)
        const a = BASEof(l) + mod(rest, pw)
        const kz = last + BASEof(rc) + floor(rest / pw) + 1
        ek = bk + 1 + kz
        ev = mod(u, 2) > 0.5 ? 0 - a - 1 : a + 1
        last = kz
        j = j + 1
        ph = RUN
        fin = j > n - 0.5 ? 1 : 0
      }
      if (fin > 0.5) {
        lastM = mode
        mL0 = part < 0.5 || (sub > 0.5 && sub < 1.5) ? mode : mL0
        mL1 = part < 0.5 || sub > 2.5 ? mode : mL1
        const ns = part > 0.5 ? sub + 1 : 4
        if (ns > 3.5) {
          sx = sx + 1
          sub = 0
          ph = sx > nsb - 0.5 ? DONE : plane > 1.5 ? BEGIN : PART
        } else {
          sub = ns
          ph = plane > 1.5 ? BEGIN : MODE
        }
      }
    }
    lk = ek
    lv = ev
    o = abs(k - my) < 0.5 ? vec4(ek, ev, o.z, o.w) : abs(k - my - 1) < 0.5 ? vec4(o.x, o.y, ek, ev) : o
  }
  if (row < 0.5) return vec4(V, R, pos, ph)
  if (row < 1.5) return vec4(sx, sub, part, lp)
  if (row < 2.5) return vec4(mL0, mL1, lastM, mode)
  if (row < 3.5) return vec4(prevN, n, j, last)
  if (row < 4.5) return vec4(rc, sel, dcL, cp)
  if (row < 5.5) return vec4(active ? s5.x + K : s5.x, pc0, 1, pend)
  if (row < 6.5) return vec4(lk, lv, pk, 0)
  return o
})
// what each step of each slice made (texel x holds steps 2x, 2x + 1 as x, y and z, w; y = slice); past the last, 1e9
const P: Buffer = buffer({ size: [2048, 96], float: 32, filter: 'nearest' }, q => {
  const old = P.at(q.cell)
  if (!going()) return done() ? old : vec4(BIG, 0, BIG, 0)
  const s5 = D.at(vec2(q.cell.y, 5))
  const p = 2 * q.cell.x
  if (p < s5.y - 0.5) return old
  if (p > s5.x - 0.5) return vec4(BIG, 0, BIG, 0)
  return D.at(vec2(q.cell.y, SLOT0 + (p - s5.y) / 2))
})
/** step p of a slice row: (key, value) */
function stepAt(row: number, p: number): vec2 {
  const t = P.at(vec2(floor(p / 2), row))
  return mod(p, 2) < 0.5 ? vec2(t.x, t.y) : vec2(t.z, t.w)
}
/** the first step of a slice row at or after `target` (keys never fall along a row) */
function findItem(row: number, target: number): number {
  let lo = 0
  let st = 4096
  for (let i = 0; i < 12; i++) {
    st = st / 2
    lo = stepAt(row, lo + st - 1).x < target - 0.5 ? lo + st : lo
  }
  return lo
}
function findEntry(row: number, start: number, target: number): number {
  let lo = start
  let st = 512
  for (let i = 0; i < 9; i++) {
    st = st / 2
    lo = stepAt(row, lo + st - 1).x < target - 0.5 ? lo + st : lo
  }
  return lo
}

// --- the rebuild: 48 tiles in lockstep, a superblock diagonal (i + 2j) of each per 4 frames ---------------------------
// Slots: luma (tile * 4 + j: tiles 4 across, 12 down, of 20 x 4 superblocks); chroma Co (tile * 2 + j) and Cg (96 +
// tile * 2 + j: tiles of 10 x 2). Slot g -> x superblock, y superblock row, z plane (0 Y, 1 Co, 2 Cg), w 1 if active.
function slotSB(g: number): vec4 {
  const lu = lumaPhase()
  const s = sbStep()
  const plane = lu ? 0 : g < 95.5 ? 1 : 2
  const h = lu ? g : g - (g < 95.5 ? 0 : 96)
  const per = lu ? 4 : 2
  const tile = floor(h / per)
  const jj = h - tile * per
  const i = s - 2 * jj
  const tws = lu ? 20 : 10
  const ok = i > -0.5 && i < tws - 0.5 && g < 191.5 && rebuilding()
  return vec4(mod(tile, 4) * tws + i, floor(tile / 4) * per + jj, plane, ok ? 1 : 0)
}
const sliceRow = (sb: vec4) => (sb.z < 0.5 ? sb.y : 24 + 24 * sb.z + sb.y)
/** this frame's block of superblock sb: x, y its top-left pixel, z its size, w its neighbours (1 above, 2 left,
 * 4 above-right; prediction never crosses a tile) */
function geom(sb: vec4, part: number, qs: number): vec4 {
  const p1 = part > 0.5
  const qx = p1 ? mod(qs, 2) : 0
  const qy = p1 ? floor(qs / 2) : 0
  const tws = sb.z < 0.5 ? 20 : 10
  const ths = sb.z < 0.5 ? 4 : 2
  const ix = imod(sb.x, tws)
  const fT = qy > 0.5 || mod(sb.y, ths) > 0.5 ? 1 : 0
  const fL = qx > 0.5 || ix > 0.5 ? 1 : 0
  const trOk = p1 ? !(qx > 0.5 && ix > tws - 1.5) && qs < 2.5 : ix < tws - 1.5
  const fTR = fT > 0.5 && trOk ? 1 : 0
  return vec4(sb.x * 16 + 8 * qx, sb.y * 16 + 8 * qy, p1 ? 8 : 16, fT + 2 * fL + 4 * fTR)
}
/** a decoded sample of a plane at (px, py), 0..255 (the planes live in pic until it is painted) */
function pixAt(plane: number, px: number, py: number): number {
  const c = pic.at(vec2(px, CH - 1 - py))
  return byte(plane < 0.5 ? c.x : plane < 1.5 ? c.y : c.z)
}
/** the block's edge k: k >= 1 the row above (k - 1, past N - 1 the above-right), 0 the corner, k <= -1 the column to
 * the left (-k - 1); missing neighbours as the converter's neighbours(): the other edge's first sample, else 128 */
function edge(plane: number, gm: vec4, k: number): number {
  const fT = mod(gm.w, 2)
  const fL = mod(floor(gm.w / 2), 2)
  const fTR = floor(gm.w / 4)
  const x0 = gm.x
  const y0 = gm.y
  let rx = x0 - 1
  let ry = y0 - 1
  let ok = 1
  if (k > 0.5) {
    if (fT > 0.5) {
      rx = x0 + (fTR > 0.5 ? k - 1 : min(k - 1, gm.z - 1))
    } else if (fL > 0.5) {
      ry = y0
    } else ok = 0
  } else if (k < -0.5) {
    if (fL > 0.5) {
      ry = y0 - k - 1
    } else if (fT > 0.5) {
      rx = x0
    } else ok = 0
  } else if (fT < 0.5 || fL < 0.5) {
    if (fT > 0.5) {
      rx = x0
    } else if (fL > 0.5) {
      ry = y0
    } else ok = 0
  }
  return ok > 0.5 ? pixAt(plane, rx, ry) : 128
}
/** coefficient position (u across, w down) -> its zigzag index in an N x N block (the order is centrally symmetric) */
function zigzag(u: number, w: number, N: number): number {
  const s = u + w
  const lo = s < N - 0.5
  const r = lo ? w : N - 1 - w
  const c = lo ? u : N - 1 - u
  const t = lo ? s : 2 * N - 2 - s
  const b = (t * (t + 1)) / 2 + (mod(t, 2) > 0.5 ? r : c)
  return lo ? b : N * N - 1 - b
}
// each slot's block header this frame: x its step in P, y 1 + its value (0: no block this frame)
const HC: Buffer = buffer({ size: [192, 1], float: 32, filter: 'nearest' }, q => {
  const sb = slotSB(q.cell.x)
  if (sb.w < 0.5) return vec4(0)
  const row = sliceRow(sb)
  const key = (sb.x * 4 + subNow()) * 512
  const h = findItem(row, key)
  const hv = stepAt(row, h)
  return abs(hv.x - key) < 0.5 ? vec4(h, hv.y + 1, 0, 1) : vec4(0)
})
// this frame's blocks' edges: slot g's edge k (-16..32, see edge()) at (g, k + 16)
const EDG: Buffer = buffer({ size: [192, 49], float: 32, filter: 'nearest' }, q => {
  const hc = HC.at(vec2(q.cell.x, 0))
  if (hc.y < 0.5) return vec4(0)
  const sb = slotSB(q.cell.x)
  const gm = geom(sb, floor((hc.y - 0.5) / 289), subNow())
  return vec4(edge(sb.z, gm, q.cell.y - 16), 0, 0, 1)
})
const edgeOf = (g: number, k: number) => EDG.at(vec2(g, k + 16)).x
// --- CDEF directions (stage ST_CD): per 8x8 block of the deblocked picture, AV1's cdef_find_dir on Y4 = r + 2g + b;
// x the direction, y its contrast
const CD: Buffer = buffer({ size: [160, 95], float: 32, filter: 'nearest' }, q => {
  const old = CD.at(q.cell)
  const st = stageNow()
  const bx = q.cell.x
  const by = q.cell.y
  if (abs(st - ST_CD) > 0.5) return st > ST_CD ? old : vec4(0)
  const p0 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  const p1 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  const p2 = [0, 0, 0, 0, 0, 0, 0, 0]
  const p3 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  const p4 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  const p5 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  const p6 = [0, 0, 0, 0, 0, 0, 0, 0]
  const p7 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (const i of range(8)) for (const j of range(8)) {
    const c = pic.at(vec2(bx * 8 + j, CH - 1 - (by * 8 + i)))
    const xv = floor((byte(c.x) + 2 * byte(c.y) + byte(c.z)) / 4) - 128
    const i2 = i < 1.5 ? 0 : i < 3.5 ? 1 : i < 5.5 ? 2 : 3
    const j2 = j < 1.5 ? 0 : j < 3.5 ? 1 : j < 5.5 ? 2 : 3
    p0[i + j] = p0[i + j]! + xv
    p1[i + j2] = p1[i + j2]! + xv
    p2[i] = p2[i]! + xv
    p3[3 + i - j2] = p3[3 + i - j2]! + xv
    p4[7 + i - j] = p4[7 + i - j]! + xv
    p5[3 - i2 + j] = p5[3 - i2 + j]! + xv
    p6[j] = p6[j]! + xv
    p7[i2 + j] = p7[i2 + j]! + xv
  }
  const sq = (x: number): Int => int(int(x) * int(x))
  const DV = [0, 840, 420, 280, 210, 168, 140, 120, 105]
  let c0 = int(0)
  let c2 = int(0)
  let c4 = int(0)
  let c6 = int(0)
  for (const i of range(8)) {
    c2 = int(c2 + int(sq(p2[i]!) * 105))
    c6 = int(c6 + int(sq(p6[i]!) * 105))
  }
  for (const i of range(7)) {
    c0 = int(c0 + int(int(sq(p0[i]!) + sq(p0[14 - i]!)) * DV[i + 1]!))
    c4 = int(c4 + int(int(sq(p4[i]!) + sq(p4[14 - i]!)) * DV[i + 1]!))
  }
  c0 = int(c0 + int(sq(p0[7]!) * 105))
  c4 = int(c4 + int(sq(p4[7]!) * 105))
  const odd = (p: number[]): Int => {
    let s = int(0)
    for (const j of range(5)) s = int(s + sq(p[3 + j]!))
    s = int(s * 105)
    for (const j of range(3)) s = int(s + int(int(sq(p[j]!) + sq(p[10 - j]!)) * DV[2 * j + 2]!))
    return s
  }
  const cs = [c0, odd(p1), c2, odd(p3), c4, odd(p5), c6, odd(p7)]
  let bd = 0
  let best = c0
  for (const dd of range(1, 8)) {
    bd = cs[dd]! > best ? dd : bd
    best = cs[dd]! > best ? cs[dd]! : best
  }
  return vec4(bd, signed(int(int(best - cs[mod(bd + 4, 8)]!) >> 10)), 0, 1)
})
// this frame's blocks' coefficients: slot g's (u, w) at x = (g mod 64) * 16 + u, y = floor(g / 64) * 16 + w. x the
// coefficient in 1/16ths, y 1 + the block's header value (0: no block), z the edge sample DC needs (w 0 the row above,
// w 1 the column to the left), w chroma: the 2x2 luma sum under the sample (chroma-from-luma)
const CF: Buffer = buffer({ size: [1024, 48], float: 32, filter: 'nearest' }, q => {
  if (!rebuilding()) return vec4(0)
  const g = floor(q.cell.y / 16) * 64 + floor(q.cell.x / 16)
  const u = mod(q.cell.x, 16)
  const w = mod(q.cell.y, 16)
  const hc = HC.at(vec2(g, 0))
  if (hc.y < 0.5) return vec4(0)
  const sb = slotSB(g)
  const qs = subNow()
  const row = sliceRow(sb)
  const key = (sb.x * 4 + qs) * 512
  const gm = geom(sb, floor((hc.y - 0.5) / 289), qs)
  const N = gm.z
  if (u > N - 0.5 || w > N - 0.5) return vec4(0, hc.y, 0, 0)
  const kz = zigzag(u, w, N)
  const e = stepAt(row, findEntry(row, hc.x + 1, key + 1 + kz))
  const lev = abs(e.x - key - 1 - kz) < 0.5 ? e.y : 0
  const qi = (sb.z > 0.5 ? 64 : 0) + (N > 8.5 ? floor(w / 2) * 8 + floor(u / 2) : w * 8 + u)
  const c16 = signed(int(int(int(int(lev) * int(quant(qi))) * at(9)) + 128) >> 8)
  const nb = w < 0.5 ? edgeOf(g, u + 1) : w < 1.5 ? edgeOf(g, 0 - u - 1) : 0
  const lx = 2 * (gm.x + u)
  const ly = 2 * (gm.y + w)
  const s4 = sb.z < 0.5 ? 0 : pixAt(0, lx, ly) + pixAt(0, lx + 1, ly) + pixAt(0, lx, ly + 1) + pixAt(0, lx + 1, ly + 1)
  return vec4(c16, hc.y, nb, s4)
})
// the row transform, at superblock columns (the block's column x at its own column in the superblock): row w, column
// x = floor((sum over u of coefficient (u, w) * basis(x, u) + 2048) / 4096); z, w the row's edge samples and 2x2 luma
// sums, added up
const TH: Buffer = buffer({ size: [1024, 48], float: 32, filter: 'nearest' }, q => {
  if (!rebuilding()) return vec4(0)
  const X = mod(q.cell.x, 16)
  const gx0 = q.cell.x - X
  const info = CF.at(vec2(gx0, q.cell.y - mod(q.cell.y, 16))).y
  if (info < 0.5) return vec4(0)
  const N = info > 289.5 ? 8 : 16
  const x = X - (N > 8.5 ? 0 : 8 * mod(subNow(), 2))
  if (x < -0.5 || x > N - 0.5) return vec4(0)
  let a = int(0)
  let nbs = 0
  let ss = 0
  for (let u = 0; u < 16; u++) {
    const c = CF.at(vec2(gx0 + u, q.cell.y))
    const bq = Q.at(vec2(u, 3 + x))
    a = int(a + int(int(c.x) * int(N > 8.5 ? bq.y : bq.z)))
    nbs = nbs + c.z
    ss = ss + c.w
  }
  return vec4(signed(int(int(a + 2048) >> 12)), info, nbs, ss)
})
const ANGN = [15, 18, 21, 27, 30, 39, 42, 45]
// this frame's blocks decoded: slot g's superblock pixel (X, Y) at x = (g mod 64) * 16 + X, y = floor(g / 64) * 16 + Y
const W: Buffer = buffer({ size: [1024, 48], float: 16, filter: 'nearest' }, q => {
  if (!rebuilding()) return vec4(0)
  const X = mod(q.cell.x, 16)
  const Y = mod(q.cell.y, 16)
  const gx0 = q.cell.x - X
  const gy0 = q.cell.y - Y
  const info = CF.at(vec2(gx0, gy0)).y
  if (info < 0.5) return vec4(0)
  const g = floor(q.cell.y / 16) * 64 + floor(q.cell.x / 16)
  const sb = slotSB(g)
  const f = info - 1
  const part = floor((f + 0.5) / 289)
  const sel = floor((f - 289 * part + 0.5) / 17)
  const m = f - 289 * part - 17 * sel
  const gm = geom(sb, part, subNow())
  const N = gm.z
  const x = X - (gm.x - sb.x * 16)
  const y = Y - (gm.y - sb.y * 16)
  if (x < -0.5 || y < -0.5 || x > N - 0.5 || y > N - 0.5) return vec4(0)
  // the column transform; and the 2x2 luma sums over the block
  let a = int(0)
  let ssum = 0
  for (let r = 0; r < 16; r++) {
    const t = TH.at(vec2(q.cell.x, gy0 + r))
    const bq = Q.at(vec2(r, 3 + y))
    a = int(a + int(int(t.x) * int(N > 8.5 ? bq.y : bq.z)))
    ssum = ssum + t.w
  }
  const res = signed(int(int(a + 32768) >> 16))
  const plane = sb.z
  const dc = floor((TH.at(vec2(q.cell.x, gy0)).z + TH.at(vec2(q.cell.x, gy0 + 1)).z + N) / (2 * N))
  // the angle n (3.75 n degrees) of a directional luma mode; a delta makes V and H directional too
  const d = plane < 0.5 ? sel - 2 : 0
  const dirOn = plane < 0.5 && (m > 8.5 || (m > 0.5 && m < 2.5 && abs(d) > 0.5))
  const an = (m < 1.5 ? 24 : m < 2.5 ? 48 : ANGN[clamp(m - 9, 0, 7)]!) + d
  const cot = an < 23.5 ? T64of(24 - an) : an < 24.5 ? 0 : 0 - T64of(an - 24)
  const xr = x * 64 + (y + 1) * cot
  const useTop = an < 47.5 && xr > -64.5
  const tn = an < 23.5 ? T64of(an) : an < 47.5 ? 0 - T64of(48 - an) : an < 48.5 ? 0 : T64of(an - 48)
  const yr = y * 64 + (x + 1) * tn
  const pr = useTop ? xr : yr
  const ii = floor(pr / 64)
  const ff = pr - 64 * ii
  const k1 = ii < -0.5 ? 0 : useTop ? min(ii, 2 * N - 1) + 1 : 0 - min(ii, N - 1) - 1
  const k2 = ii + 1 < -0.5 ? 0 : useTop ? min(ii + 1, 2 * N - 1) + 1 : 0 - min(ii + 1, N - 1) - 1
  // up to four edge samples, by mode
  const d45 = m > 4.5 && m < 5.5
  const d135 = m > 5.5 && m < 6.5
  const kA = dirOn ? k1 : d45 ? min(x + y, 2 * N - 1) + 1 : d135 ? clamp(x - y - 1, 0 - N, N) : x + 1
  const kB = dirOn ? k2 : d45 ? min(x + y + 1, 2 * N - 1) + 1 : d135 ? clamp(x - y, 0 - N, N) : 0 - y - 1
  const kC = d45 ? min(x + y + 2, 2 * N - 1) + 1 : d135 ? clamp(x - y + 1, 0 - N, N) : m > 3.5 && m < 4.5 ? 0 - N : 0
  const A = edgeOf(g, kA)
  const B = edgeOf(g, kB)
  const C = edgeOf(g, kC)
  const E = edgeOf(g, N)
  const base = A + B - C
  const pl = abs(base - B)
  const pt = abs(base - A)
  const pc = abs(base - C)
  const paeth = pl <= pt && pl <= pc ? B : pt <= pc ? A : C
  const smo = floor(((N - y) * A + (y + 1) * C + (N - x) * B + (x + 1) * E + N + 1.5) / (2 * N + 2))
  const tri = floor((A + 2 * B + C + 2) / 4)
  const dirv = floor((A * (64 - ff) + B * ff + 32) / 64)
  const mean = floor((ssum + (N * N) / 2) / (N * N))
  const cfl = clamp(dc + floor((Q.at(vec2(sel, 2)).y * (CF.at(vec2(gx0 + x, gy0 + y)).w - mean) + 16) / 32), 0, 255)
  const pred = dirOn ? dirv : m < 0.5 ? dc : m < 1.5 ? A : m < 2.5 ? B : m < 3.5 ? paeth : m < 4.5 ? smo : m < 6.5 ? tri : m < 7.5 ? clamp(A + B - C, 0, 255) : cfl
  return vec4(clamp(res + pred, 0, 255), 0, 0, 1)
})
// --- deblocking, a window a frame (then CDEF, a band a frame) ---------------------------------------------------------
// The 8x8 blocks show as steps at their edges. Across each edge (luma every 8 pixels, chroma every 16), a step smaller
// than a real edge is ramped out over 4 pixels each side where both blocks are flat, or eased at the two edge pixels
// where they are not. Thresholds follow the quantiser. `dbH` does the columns of this frame's window (read from `pic`
// as last frame left it, still raw there), `dbV` the rows, and `pic` keeps it.
function yccAt(x: number, ty: number): vec3 {
  const c = pic.at(vec2(x, ty))
  const r = byte(c.x)
  const g = byte(c.y)
  const b = byte(c.z)
  return vec3((r + 2 * g + b) / 4, (r - b) / 2, (2 * g - r - b) / 4)
}
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
  const ql = (signed(at(9)) * quant(0)) / 32768
  const qc = (signed(at(9)) * quant(64)) / 32768
  const y = deb(t0.x, t1.x, t2.x, t3.x, t4.x, t5.x, t6.x, t7.x, k, ql * 4, ql * 1.5, ql)
  const self = k < -3.5 ? t0 : k < -2.5 ? t1 : k < -1.5 ? t2 : k < -0.5 ? t3 : k < 0.5 ? t4 : k < 1.5 ? t5 : k < 2.5 ? t6 : t7
  const o = chroma > 0.5 ? deb(t0.y, t1.y, t2.y, t3.y, t4.y, t5.y, t6.y, t7.y, k, qc * 4, qc * 1.5, qc) : self.y
  const g = chroma > 0.5 ? deb(t0.z, t1.z, t2.z, t3.z, t4.z, t5.z, t6.z, t7.z, k, qc * 4, qc * 1.5, qc) : self.z
  return vec3(y, o, g)
}
// CDEF taps: direction d's two steps (dy, dx)
const DY0 = [-1, 0, 0, 0, 1, 1, 1, 1]
const DX0 = [1, 1, 1, 1, 1, 0, 0, 0]
const DY1 = [-2, -1, 0, 1, 2, 2, 2, 2]
const DX1 = [2, 2, 2, 2, 2, 1, 0, -1]
/** 2^(8 - floor(log2 thr)) for a strength 1..63: constrain()'s divisor at damping 8 */
const cdefDiv = (thr: number) => (thr > 31.5 ? 8 : thr > 15.5 ? 16 : thr > 7.5 ? 32 : thr > 3.5 ? 64 : thr > 1.5 ? 128 : 256)
/** Y4 of the deblocked picture; rows at or below `below` were CDEF'd already, so they come from dbV's copy */
function y4At(x: number, py: number, below: number): number {
  const c = py > below - 0.5 ? dbV.at(vec2(x, py - below)) : pic.at(vec2(x, CH - 1 - py))
  return byte(c.x) + 2 * byte(c.y) + byte(c.z)
}
/** AV1's cdef_filter on luma (Y4 = r + 2g + b of the deblocked picture), the unit's preset from words 1120..1151; the
 * change spread over r, g and b */
function cdefAt(x: number, pr: number, below: number): vec4 {
  const py = min(pr, PH - 1)
  const c0 = pic.at(vec2(x, CH - 1 - py))
  const r = byte(c0.x)
  const g = byte(c0.y)
  const b = byte(c0.z)
  const c = r + 2 * g + b
  const cdv = CD.at(vec2(floor(x / 8), floor(py / 8)))
  const d = cdv.x
  const vr = cdv.y
  const un = floor(py / 64) * 20 + floor(x / 64)
  const pi = signed(int(int(at(1122 + floor(un / 8)) >>> int(3 * (7 - mod(un, 8)))) & 7))
  const ci = signed(int(int(at(1120 + floor(pi / 4)) >>> int(6 * (3 - mod(pi, 4)))) & 63))
  const sc = mod(ci, 4)
  // the primary strength follows the block's contrast: floor(log2(vr / 64)), at most 12
  const v64 = floor(vr / 64)
  let lg = 0
  let pw = 2
  for (let i = 1; i < 13; i++) {
    lg = v64 > pw - 0.5 ? i : lg
    pw = pw * 2
  }
  const ps = vr > 0.5 ? floor((floor(ci / 4) * (4 + lg) + 8) / 16) * 4 : 0
  const ss = (sc > 2.5 ? 4 : sc) * 4
  const dvP = cdefDiv(ps)
  const dvS = cdefDiv(ss)
  let sum = 0
  let mx = c
  let mn = c
  const tap = (dir: number, kk: number, sg: number, thr: number, dv: number, wt: number) => {
    const yy = py + sg * (kk < 0.5 ? DY0[dir]! : DY1[dir]!)
    const xx = x + sg * (kk < 0.5 ? DX0[dir]! : DX1[dir]!)
    if (thr > 0.5 && yy > -0.5 && yy < PH - 0.5 && xx > -0.5 && xx < 1279.5) {
      const t = y4At(xx, yy, below)
      const ad = abs(t - c)
      const cv = clamp(thr - floor(ad / dv), 0, ad)
      sum = sum + wt * (t < c ? 0 - cv : cv)
      mx = max(mx, t)
      mn = min(mn, t)
    }
  }
  const odd = mod(ps / 4, 2) > 0.5
  for (const kk of range(2)) for (const sg of [1, -1]) {
    tap(d, kk, sg, ps, dvP, odd ? 3 : kk < 0.5 ? 4 : 2)
    tap(mod(d + 2, 8), kk, sg, ss, dvS, kk < 0.5 ? 2 : 1)
    tap(mod(d + 6, 8), kk, sg, ss, dvS, kk < 0.5 ? 2 : 1)
  }
  const y4 = ps < 0.5 && ss < 0.5 ? c : clamp(c + floor((8 + sum - (sum < 0 ? 1 : 0)) / 16), mn, mx)
  const dl = (y4 - c) / 4
  return vec4(clamp(floor(r + dl + 0.5), 0, 255), clamp(floor(g + dl + 0.5), 0, 255), clamp(floor(b + dl + 0.5), 0, 255), 1)
}
// window row wr (0 at the top, y = 31 - cell.y) is picture row 32w - 4 + wr; a CDEF band's row 31 - cell.y is 32b + that
const dbH: Buffer = buffer({ size: [1280, 32], float: 32, filter: 'nearest' }, q => {
  if (cdefing()) return cdefAt(q.cell.x, fband() * 32 + 31 - q.cell.y, fband() * 32 + 32)
  if (!deblocking()) return vec4(0)
  const ty = CH - 1 - clamp(win() * 32 - 4 + 31 - q.cell.y, 0, PH - 1)
  const m = mod(q.cell.x, 8)
  const k = m < 3.5 ? m : m - 8
  const e = q.cell.x - k
  const tap = (i: number) => yccAt(clamp(e + i, 0, 1279), ty)
  if (e < 0.5 || e > 1279.5) {
    const c = yccAt(q.cell.x, ty)
    return vec4(c.x, c.y, c.z, 1)
  }
  const c = debLine(tap(-4), tap(-3), tap(-2), tap(-1), tap(0), tap(1), tap(2), tap(3), k, mod(e, 16) < 0.5 ? 1 : 0)
  return vec4(c.x, c.y, c.z, 1)
})
const out8 = (x: number) => clamp(floor(x + 0.5), 0, 255) / 255
// the deblocked window's rgb; while CDEF runs, rows 0 and 1 keep the band's top two rows as they were before it
const dbV: Buffer = buffer({ size: [1280, 32], filter: 'nearest' }, q => {
  if (cdefing()) {
    const c = pic.at(vec2(q.cell.x, CH - 1 - min(fband() * 32 + q.cell.y, PH - 1)))
    return q.cell.y < 1.5 ? vec4(c.x, c.y, c.z, 1) : vec4(0)
  }
  if (!deblocking()) return vec4(0)
  const wr = 31 - q.cell.y
  const r = win() * 32 - 4 + wr
  const m = mod(r, 8)
  const k = m < 3.5 ? m : m - 8
  const e = r - k
  // the edge's 8 rows, all inside this window
  const tap = (i: number) => {
    const t = dbH.at(vec2(q.cell.x, q.cell.y + k - i))
    return vec3(t.x, t.y, t.z)
  }
  const h = dbH.at(q.cell)
  const c = e < 0.5 || e > PH - 0.5 ? vec3(h.x, h.y, h.z) : debLine(tap(-4), tap(-3), tap(-2), tap(-1), tap(0), tap(1), tap(2), tap(3), k, mod(e, 16) < 0.5 ? 1 : 0)
  return vec4(out8(c.x + c.y - c.z), out8(c.x + c.z), out8(c.x - c.y - c.z), 1)
})

// The planes, then the picture (alpha 1 where painted). During the rebuild: r luma (1280 x 768), g Co and b Cg
// (640 x 384, at x < 640, picture row < 384); row py at y = CH - 1 - py. Each frame copies in the blocks W decoded.
const pic: Buffer = buffer({ size: [1280, 768], filter: 'linear', wrap: 'clamp' }, q => {
  const old = pic.at(q.cell)
  const st = stageNow()
  if (st < 0.5) return vec4(0)
  if (done()) return old
  const px = q.cell.x
  const py = CH - 1 - q.cell.y
  if (cdefing()) {
    const rr = py - fband() * 32
    if (rr < -0.5 || rr > 31.5 || py > PH - 0.5) return old
    const c = dbH.at(vec2(px, 31 - rr))
    return vec4(c.x / 255, c.y / 255, c.z / 255, 1)
  }
  // deblocked window w (its rows were painted a frame or more ago)
  const wr = py - (win() * 32 - 4)
  if (deblocking() && wr > -0.5 && wr < 31.5) {
    const c = dbV.at(vec2(px, 31 - wr))
    return vec4(c.x, c.y, c.z, 1)
  }
  if (painting()) {
    const rr = py - (ST_P0 + 11 - st) * 64
    if (rr < -0.5 || rr > 63.5) return old
    const yv = byte(old.x)
    // chroma sits between luma pixels: blend the four nearest (weights 1/4, 3/4: exact)
    const cx = clamp(px / 2 - 0.25, 0, 639)
    const cy = clamp(py / 2 - 0.25, 0, 383)
    const x0 = floor(cx)
    const y0 = floor(cy)
    const x1 = min(x0 + 1, 639)
    const y1 = min(y0 + 1, 383)
    const ax = cx - x0
    const ay = cy - y0
    const c00 = pic.at(vec2(x0, CH - 1 - y0))
    const c10 = pic.at(vec2(x1, CH - 1 - y0))
    const c01 = pic.at(vec2(x0, CH - 1 - y1))
    const c11 = pic.at(vec2(x1, CH - 1 - y1))
    const o = (byte(c00.y) * (1 - ax) + byte(c10.y) * ax) * (1 - ay) + (byte(c01.y) * (1 - ax) + byte(c11.y) * ax) * ay - 128
    const gg = (byte(c00.z) * (1 - ax) + byte(c10.z) * ax) * (1 - ay) + (byte(c01.z) * (1 - ax) + byte(c11.z) * ax) * ay - 128
    return vec4(out8(yv + o - gg), out8(yv + gg), out8(yv - o - gg), 1)
  }
  if (!rebuilding()) return old
  const sx = floor(px / 16)
  const sy = floor(py / 16)
  const X = px - 16 * sx
  const Y = py - 16 * sy
  const s = sbStep()
  if (lumaPhase()) {
    const tc = floor((sx + 0.5) / 20)
    const jj = mod(sy, 4)
    if (abs(sx - 20 * tc + 2 * jj - s) > 0.5) return old
    const g = (floor(sy / 4) * 4 + tc) * 4 + jj
    const wv = W.at(vec2(mod(g, 64) * 16 + X, floor(g / 64) * 16 + Y))
    // alpha 0.4: luma rebuilt, not yet painted (the picture keeps the flat colour until then)
    return wv.w > 0.5 ? vec4(wv.x / 255, old.y, old.z, 0.4) : old
  }
  if (px > 639.5 || py > 383.5) return old
  const tc = floor((sx + 0.5) / 10)
  const jj = mod(sy, 2)
  if (abs(sx - 10 * tc + 2 * jj - s) > 0.5) return old
  const g = (floor(sy / 2) * 4 + tc) * 2 + jj
  const co = W.at(vec2(mod(g, 64) * 16 + X, floor(g / 64) * 16 + Y))
  const cg = W.at(vec2(mod(g + 96, 64) * 16 + X, floor((g + 96) / 64) * 16 + Y))
  return vec4(old.x, co.w > 0.5 ? co.x / 255 : old.y, cg.w > 0.5 ? cg.x / 255 : old.z, old.a)
})

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
  const ph = (time * (1 - still) * 6.2831853) / loop
  let dx = 0
  let dy = 0
  for (const h of [1, 2, 3]) {
    const w = at(16 + n * 3 + h - 1)
    const k = signed(at(h)) / 65536 / 31
    const c = cos(ph * h) - 1
    const s = sin(ph * h)
    dx = dx + ((field(w, 18) * c + field(w, 12) * s) * k) / fw
    dy = dy + ((field(w, 6) * c + field(w, 0) * s) * k) / fh
  }
  const on = done() ? 1 : 0
  return vec4(dx * on, dy * on, 0, 1)
})

export default shader({
  fps: 30,
  passes: [acc, ctl, Q, D, P, HC, EDG, CD, CF, TH, W, dbH, dbV, pic, sway, picture(q => {
    const pa = signed(at(5)) / 1000000
    const a = pa > 0.1 ? pa : 1.684
    const aspect = size.x / size.y
    const fx = min(1, aspect / a)
    const fy = min(1, a / aspect)
    const p = vec2(0.5 + (q.uv.x - 0.5) * fx, 0.5 + (q.uv.y - 0.5) * fy)
    const d = sway.sample(p)
    const c = pic.sample(vec2(p.x - d.x, (CH - PH) / CH + ((p.y + d.y) * PH) / CH))
    const flat = scene.sample(vec2(0.99, 0.02))
    const img = c.a > 0.5 ? vec3(c.x, c.y, c.z) : vec3(flat.x, flat.y, flat.z)
    if (v.debug < 0.5 || q.uv.y < 0.9) return vec4(img.x, img.y, img.z, 1)
    // debug strip: words seen (green, top), then the stage (yellow while decoding, white after, growing)
    const r = ctl.at(vec2(1, 14))
    const st = stageNow()
    const top = q.uv.y > 0.95
    const bar = top ? q.uv.x < r.y / WORDS : q.uv.x < (st > 0.5 ? st / ST_DONE : r.x > 0.5 ? 0.05 : 0)
    const lit = top ? vec3(0.1, 0.8, 0.2) : st > 0.5 ? vec3(1, 1, 1) : vec3(1, 0.85, 0.1)
    return bar ? vec4(lit.x, lit.y, lit.z, 1) : vec4(0.15, 0.15, 0.15, 1)
  })],
})
