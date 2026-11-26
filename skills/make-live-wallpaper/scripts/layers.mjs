// layers.mjs: motion layers for the live keyframe. A part that moves over what is behind it (a head over a still city,
// a toy on a railing) gets a motion field of its own, so the background beside it stays put instead of bending along.
//
//   node layers.mjs <work dir> <out pack.json> [--budget 1008] [--mask <png>] [--video <file> --ffmpeg <exe>]
//
// Reads work/loop.gray (the motion frames, 320 x 190 grey), work/mot.48.json (the one-field grid warp at 48 x 28; made
// here if missing), work/ref.rgb (the 1920 x 1140 keyframe), work/pack.json (the one-field motion, for comparison).
// Writes work/layers/: coarse.png (the parts' outline from motion alone), mask.png (1280 x 760, black = background, a
// flat colour a part: the file a person paints over to correct it, then reruns with --mask), overlay.png, fg.json and
// bg.json (the two fields, per frame), report.txt; and the pack (motion v2, layered) unless no part is found, in which
// case it writes nothing and says so (the one-field motion stays).
//
// Method. Segmentation (after Wang & Adelson's layers): moving blobs (temporal std) are the first guess; a grid warp is
// fitted on the parts' pixels (foreground) and one on the rest (background); each pixel near a part goes to the warp
// whose median loop error is lower (median: a pixel a part covers for under half the loop keeps its own behaviour);
// largest piece, holes filled; refit; 3 rounds. A blob its own warp explains under 35% of is light, not motion, and is
// dropped. The outline is then snapped to the keyframe's edges (geodesic, after Bai & Sapiro) and traced to polygons.
// Playback rule: hooks/live-key.ts, LD (the comment there), mirrored by layerD below.
// Stream: both fields as one motion v2 block over two 48 x 28 grids (background's nodes, then the parts'), sharing the
// curves; the outline's vertices after it (pack.words), pack.layers = { first, count, word2 } for ka2-enc.mjs.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readPNG, writePNG } from './png.mjs'
import { fit } from './mv2.mjs'

export const OW = 1280, OH = 760
export const RIM = 2, BAND = 6, LEAD = 12 // the playback rule's widths in picture pixels (word 2, eighths)
export const MAXV = 812 // the shader adds 4 edges a frame over 203 stages
const COLORS = [[230, 40, 40], [40, 200, 60], [50, 90, 240], [240, 210, 30], [220, 50, 220], [40, 210, 220]]
const NAMES = ['red', 'green', 'blue', 'yellow', 'magenta', 'cyan']

// --- frames, blur, masks ---------------------------------------------------------------------------------------------
function loadFrames(path, W, H) {
  const raw = readFileSync(path), S = W * H, N = Math.floor(raw.length / S)
  return { N, frame: f => Float32Array.from(raw.subarray(f * S, (f + 1) * S)) }
}
function blur(src, W, H, r) { // three box passes ~ gaussian
  if (r < 1) return src
  let a = src
  for (let pass = 0; pass < 3; pass++) {
    const b = new Float32Array(W * H), c = new Float32Array(W * H)
    for (let y = 0; y < H; y++) { let s = 0, n = 0
      for (let x = -r; x < W + r; x++) {
        if (x + r < W) { s += a[y * W + Math.max(0, x + r)]; n++ }
        if (x - r - 1 >= 0) { s -= a[y * W + x - r - 1]; n-- }
        if (x >= 0 && x < W) b[y * W + x] = s / n
      } }
    for (let x = 0; x < W; x++) { let s = 0, n = 0
      for (let y = -r; y < H + r; y++) {
        if (y + r < H) { s += b[Math.max(0, y + r) * W + x]; n++ }
        if (y - r - 1 >= 0) { s -= b[(y - r - 1) * W + x]; n-- }
        if (y >= 0 && y < H) c[y * W + x] = s / n
      } }
    a = c
  }
  return a
}
function samp(img, W, H, x, y) {
  x = Math.max(0, Math.min(W - 1.001, x)); y = Math.max(0, Math.min(H - 1.001, y))
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * W + x0
  return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + W] * (1 - fx) + img[i + W + 1] * fx) * fy
}
function sampG(img, W, H, x, y, out) {
  x = Math.max(0, Math.min(W - 1.001, x)); y = Math.max(0, Math.min(H - 1.001, y))
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * W + x0
  const a = img[i], b = img[i + 1], c = img[i + W], d = img[i + W + 1]
  out[0] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
  out[1] = (b - a) * (1 - fy) + (d - c) * fy
  out[2] = (c - a) * (1 - fx) + (d - b) * fx
}
function stdMap(fr, N, S) {
  const m = new Float64Array(S), q = new Float64Array(S)
  for (let f = 0; f < N; f++) { const a = fr(f); for (let i = 0; i < S; i++) { m[i] += a[i]; q[i] += a[i] * a[i] } }
  return Float32Array.from(m, (v, i) => Math.sqrt(Math.max(0, q[i] / N - (v / N) ** 2)))
}
const grow = (m, W, H, r) => { const b = blur(Float32Array.from(m), W, H, r); return Uint8Array.from(b, v => (v > 0.02 ? 1 : 0)) }
const shrink = (m, W, H, r) => { const b = blur(Float32Array.from(m), W, H, r); return Uint8Array.from(b, v => (v > 0.98 ? 1 : 0)) }
function components(m, W, H) { // 4-connected; { lab (0 = none), comps: [{ id, n }] }
  const lab = new Int32Array(W * H), comps = []
  for (let s = 0; s < W * H; s++) {
    if (!m[s] || lab[s]) continue
    const id = comps.length + 1, st = [s]; lab[s] = id; let n = 0
    while (st.length) { const i = st.pop(); n++; const x = i % W, y = (i / W) | 0
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) if (j >= 0 && m[j] && !lab[j]) { lab[j] = id; st.push(j) } }
    comps.push({ id, n })
  }
  return { lab, comps }
}
function fillHoles(m, W, H) { // what the outside cannot reach becomes part of the mask
  const out = new Uint8Array(W * H), st = []
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) if (!m[y * W + x]) { out[y * W + x] = 1; st.push(y * W + x) }
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) if (!m[y * W + x] && !out[y * W + x]) { out[y * W + x] = 1; st.push(y * W + x) }
  while (st.length) { const i = st.pop(), x = i % W, y = (i / W) | 0
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) if (j >= 0 && !m[j] && !out[j]) { out[j] = 1; st.push(j) } }
  return Uint8Array.from(out, v => 1 - v)
}
function largest(m, W, H) {
  const { lab, comps } = components(m, W, H)
  if (!comps.length) return m
  const best = comps.reduce((a, b) => (b.n > a.n ? b : a)).id
  return Uint8Array.from(lab, v => (v === best ? 1 : 0))
}

// --- grid warps (flow2.mjs's model) ----------------------------------------------------------------------------------
/** D at pixel (x, y) of a W x H frame: bilinear between cell-centre nodes, clamped */
export function gridD(m, f, x, y, W, H) {
  const u = Math.max(0, Math.min(m.GX - 1, ((x + 0.5) / W) * m.GX - 0.5)), v = Math.max(0, Math.min(m.GY - 1, ((y + 0.5) / H) * m.GY - 0.5))
  const i0 = Math.min(m.GX - 2, Math.floor(u)), j0 = Math.min(m.GY - 2, Math.floor(v)), fu = u - i0, fv = v - j0
  const d = (i, j) => m.tracks[j * m.GX + i].d[f % m.N]
  const a = d(i0, j0), b = d(i0 + 1, j0), c = d(i0, j0 + 1), e = d(i0 + 1, j0 + 1)
  const s = [W / m.W, H / m.H]
  return [0, 1].map(k => ((a[k] * (1 - fu) + b[k] * fu) * (1 - fv) + (c[k] * (1 - fu) + e[k] * fu) * fv) * s[k])
}
/** flow2's per-frame grid warp with a weight per pixel (0 = another layer's pixel, ignored); nodes no weighted pixel
 * reaches are filled smoothly from their neighbours */
export function fitGrid(fr, N, W, H, GX, GY, weight) {
  const LEVELS = [4, 2, 1, 0], base = fr(0), refs = LEVELS.map(r => blur(base, W, H, r)), G = GX * GY
  const nodeOf = new Int32Array(W * H * 4), wOf = new Float32Array(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = Math.max(0, Math.min(GX - 1, ((x + 0.5) / W) * GX - 0.5)), v = Math.max(0, Math.min(GY - 1, ((y + 0.5) / H) * GY - 0.5))
    const i0 = Math.min(GX - 2, Math.floor(u)), j0 = Math.min(GY - 2, Math.floor(v)), fu = u - i0, fv = v - j0, p = (y * W + x) * 4
    nodeOf[p] = j0 * GX + i0; wOf[p] = (1 - fu) * (1 - fv); nodeOf[p + 1] = j0 * GX + i0 + 1; wOf[p + 1] = fu * (1 - fv)
    nodeOf[p + 2] = (j0 + 1) * GX + i0; wOf[p + 2] = (1 - fu) * fv; nodeOf[p + 3] = (j0 + 1) * GX + i0 + 1; wOf[p + 3] = fu * fv
  }
  const pix = []; for (let i = 0; i < W * H; i++) if (weight[i] > 0) pix.push(i)
  const D = new Float64Array(G * 2), all = [Array.from(D)], t = new Float64Array(3)
  for (let f = 1; f < N; f++) {
    const cur = fr(f)
    for (let li = 0; li < LEVELS.length; li++) {
      const ref = refs[li], img = blur(cur, W, H, LEVELS[li]), iters = li === LEVELS.length - 1 ? 6 : 10
      for (let it = 0; it < iters; it++) {
        const A = new Float64Array(G * 3), b = new Float64Array(G * 2)
        for (const i of pix) {
          const x = i % W, y = (i / W) | 0, p = i * 4
          let dx = 0, dy = 0
          for (let k = 0; k < 4; k++) { const n = nodeOf[p + k], w = wOf[p + k]; dx += w * D[2 * n]; dy += w * D[2 * n + 1] }
          sampG(ref, W, H, x - dx, y - dy, t)
          const r = t[0] - img[i], rob = weight[i] / Math.max(1, Math.abs(r) / 12), gx = -t[1], gy = -t[2]
          for (let k = 0; k < 4; k++) {
            const n = nodeOf[p + k], w2 = wOf[p + k] * wOf[p + k] * rob
            A[3 * n] += w2 * gx * gx; A[3 * n + 1] += w2 * gx * gy; A[3 * n + 2] += w2 * gy * gy
            b[2 * n] += w2 * gx * r; b[2 * n + 1] += w2 * gy * r
          }
        }
        const mu = 400 + 0.15 * ((W * H) / G) * 4, ND = new Float64Array(D)
        for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
          const n = j * GX + i; let mx = 0, my = 0, c = 0
          for (const [a2, b2] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) if (a2 >= 0 && a2 < GX && b2 >= 0 && b2 < GY) { mx += D[2 * (b2 * GX + a2)]; my += D[2 * (b2 * GX + a2) + 1]; c++ }
          mx = mx / c - D[2 * n]; my = my / c - D[2 * n + 1]
          const a11 = A[3 * n] + mu, a12 = A[3 * n + 1], a22 = A[3 * n + 2] + mu, r1 = -b[2 * n] + mu * mx, r2 = -b[2 * n + 1] + mu * my, det = a11 * a22 - a12 * a12
          let sx = (a22 * r1 - a12 * r2) / det, sy = (a11 * r2 - a12 * r1) / det
          const m = Math.hypot(sx, sy), cap = 1 + LEVELS[li]; if (m > cap) { sx *= cap / m; sy *= cap / m }
          ND[2 * n] += sx; ND[2 * n + 1] += sy
        }
        D.set(ND)
      }
    }
    all.push(Array.from(D, v => +v.toFixed(2)))
  }
  return { W, H, GX, GY, N, tracks: Array.from({ length: G }, (_, n) => ({ d: all.map(F => [F[2 * n], F[2 * n + 1]]) })) }
}

// --- the mask file and snapping --------------------------------------------------------------------------------------
export function readMask(path) { // -> Int8Array OW x OH: -1 background, k part (nearest colour)
  const m = readPNG(path)
  if (m.w !== OW || m.h !== OH) throw new Error(`${path} is ${m.w} x ${m.h}; the mask must stay ${OW} x ${OH}`)
  const own = new Int8Array(OW * OH)
  for (let i = 0; i < OW * OH; i++) {
    const r = m.rgb[i * 3], g = m.rgb[i * 3 + 1], b = m.rgb[i * 3 + 2]
    let best = r * r + g * g + b * b, who = -1
    COLORS.forEach((k, j) => { const d = (r - k[0]) ** 2 + (g - k[1]) ** 2 + (b - k[2]) ** 2; if (d < best) { best = d; who = j } })
    own[i] = who
  }
  return own
}
function writeMask(path, own) {
  const out = new Uint8Array(OW * OH * 3)
  for (let i = 0; i < OW * OH; i++) if (own[i] >= 0) out.set(COLORS[own[i] % COLORS.length], i * 3)
  writePNG(path, OW, OH, out)
}
function picture(ref) { // the 1920 x 1140 keyframe averaged down to 1280 x 760
  const RW = 1920, RH = 1140, pic = new Float32Array(OW * OH * 3)
  for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) for (let c = 0; c < 3; c++) {
    let s = 0
    for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) s += ref[(Math.min(RH - 1, Math.floor(y * 1.5) + b) * RW + Math.min(RW - 1, Math.floor(x * 1.5) + a)) * 3 + c]
    pic[(y * OW + x) * 3 + c] = s / 4
  }
  return pic
}
function chamfer(own, inside) { // distance to the nearest pixel where inside() is false
  const P = OW * OH, d = new Float32Array(P)
  for (let i = 0; i < P; i++) d[i] = inside(own[i]) ? 1e9 : 0
  for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
    const i = y * OW + x; let v = d[i]
    if (x) v = Math.min(v, d[i - 1] + 1)
    if (y) v = Math.min(v, d[i - OW] + 1)
    if (x && y) v = Math.min(v, d[i - OW - 1] + 1.414)
    if (y && x < OW - 1) v = Math.min(v, d[i - OW + 1] + 1.414)
    d[i] = v
  }
  for (let y = OH - 1; y >= 0; y--) for (let x = OW - 1; x >= 0; x--) {
    const i = y * OW + x; let v = d[i]
    if (x < OW - 1) v = Math.min(v, d[i + 1] + 1)
    if (y < OH - 1) v = Math.min(v, d[i + OW] + 1)
    if (x < OW - 1 && y < OH - 1) v = Math.min(v, d[i + OW + 1] + 1.414)
    if (y < OH - 1 && x) v = Math.min(v, d[i + OW - 1] + 1.414)
    d[i] = v
  }
  return d
}
/** moves the outlines onto the picture's own edges within a band (SIN px inside, SOUT outside); in place. Deep inside a
 * part and well outside all parts are certain; each band pixel goes to the side that reaches it more cheaply, a step
 * costing the colour difference of the two pixels, so the boundary settles on the strongest edge in the band. */
export function snap(own, pic, SIN, SOUT) {
  const P = OW * OH, dIn = chamfer(own, v => v >= 0), dOut = chamfer(own, v => v < 0)
  const lab = new Int8Array(P).fill(-2)
  let parts = 0
  for (let i = 0; i < P; i++) {
    if (own[i] + 1 > parts) parts = own[i] + 1
    if (own[i] >= 0 && dIn[i] > SIN) lab[i] = own[i]
    else if (own[i] < 0 && dOut[i] > SOUT) lab[i] = -1
  }
  for (let k = 0; k < parts; k++) { // a part thinner than the band keeps its middle
    let has = false, m = 0
    for (let i = 0; i < P; i++) if (own[i] === k) { m = Math.max(m, dIn[i]); if (lab[i] === k) has = true }
    if (!has) for (let i = 0; i < P; i++) if (own[i] === k && dIn[i] > m / 2) lab[i] = k
  }
  // Dijkstra over the band; costs in Float64 (Float32 re-pushes equal-cost paths without end)
  const cost = new Float64Array(P).fill(Infinity), from = Int8Array.from(lab)
  let hc = new Float64Array(1 << 16), hp = new Int32Array(1 << 16), n = 0, popC = 0
  const push = (c, i) => {
    if (n === hc.length) { const a = new Float64Array(n * 2), b = new Int32Array(n * 2); a.set(hc); b.set(hp); hc = a; hp = b }
    let k = n++
    while (k) { const p = (k - 1) >> 1; if (hc[p] <= c) break; hc[k] = hc[p]; hp[k] = hp[p]; k = p }
    hc[k] = c; hp[k] = i
  }
  const pop = () => {
    const i = hp[0]; popC = hc[0]
    const c = hc[--n], q = hp[n]; let k = 0
    for (;;) { let m = 2 * k + 1; if (m >= n) break; if (m + 1 < n && hc[m + 1] < hc[m]) m++; if (hc[m] >= c) break; hc[k] = hc[m]; hp[k] = hp[m]; k = m }
    hc[k] = c; hp[k] = q
    return i
  }
  for (let i = 0; i < P; i++) {
    if (lab[i] === -2) continue
    const x = i % OW, y = (i / OW) | 0
    if ((x > 0 && lab[i - 1] === -2) || (x < OW - 1 && lab[i + 1] === -2) || (y > 0 && lab[i - OW] === -2) || (y < OH - 1 && lab[i + OW] === -2)) { cost[i] = 0; push(0, i) }
  }
  const step = (i, j, c) => {
    if (lab[j] !== -2) return
    const nc = c + 1 + Math.hypot(pic[i * 3] - pic[j * 3], pic[i * 3 + 1] - pic[j * 3 + 1], pic[i * 3 + 2] - pic[j * 3 + 2])
    if (nc < cost[j]) { cost[j] = nc; from[j] = from[i]; push(nc, j) }
  }
  while (n) {
    const i = pop(), c = popC
    if (c > cost[i]) continue
    const x = i % OW, y = (i / OW) | 0
    if (x > 0) step(i, i - 1, c)
    if (x < OW - 1) step(i, i + 1, c)
    if (y > 0) step(i, i - OW, c)
    if (y < OH - 1) step(i, i + OW, c)
  }
  let moved = 0
  for (let i = 0; i < P; i++) { if (from[i] !== own[i]) moved++; own[i] = from[i] }
  return moved / P
}
function overlay(own, pic) { // 640 x 380: parts tinted, outlines white, the rest dimmed
  const w = 640, h = 380, out = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * 2 * OW + x * 2, k = own[i]
    let edge = false
    for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) { const j = (y * 2 + b) * OW + x * 2 + a; const X = x * 2 + a, Y = y * 2 + b
      if ((X > 0 && own[j - 1] !== own[j]) || (Y > 0 && own[j - OW] !== own[j])) edge = true }
    for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = edge ? 255 : k >= 0 ? Math.round(pic[i * 3 + c] * 0.55 + COLORS[k % COLORS.length][c] * 0.45) : Math.round(pic[i * 3 + c] * 0.6)
  }
  return { w, h, rgb: out }
}

// --- the outline as polygons, and the shader's way of reading it back --------------------------------------------------
/** binary mask (OW x OH, 1 inside) -> closed loops of pixel-corner points, inside on the right */
function trace(bin) {
  const W = OW, H = OH, ins = (x, y) => x >= 0 && y >= 0 && x < W && y < H && bin[y * W + x] > 0
  const out = new Map()
  const add = (x0, y0, x1, y1) => { const k = y0 * (W + 1) + x0; (out.get(k) || out.set(k, []).get(k)).push([x1, y1]) }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!ins(x, y)) continue
    if (!ins(x, y - 1)) add(x, y, x + 1, y)
    if (!ins(x + 1, y)) add(x + 1, y, x + 1, y + 1)
    if (!ins(x, y + 1)) add(x + 1, y + 1, x, y + 1)
    if (!ins(x - 1, y)) add(x, y + 1, x, y)
  }
  const loops = []
  for (const [k0, list] of out) {
    while (list.length) {
      let x = k0 % (W + 1), y = (k0 / (W + 1)) | 0, dir = null
      const loop = []
      for (;;) {
        const cand = out.get(y * (W + 1) + x)
        if (!cand || !cand.length) break
        let pick = 0 // at a saddle corner take the right-most turn, so touching loops stay apart
        if (cand.length > 1 && dir) {
          const score = ([nx, ny]) => { const cr = dir[0] * (ny - y) - dir[1] * (nx - x); return cr > 0 ? 0 : cr === 0 ? 1 : 2 }
          pick = cand.map(score).reduce((b, s, i, a) => (s < a[b] ? i : b), 0)
        }
        const [nx, ny] = cand.splice(pick, 1)[0]
        loop.push([x, y]); dir = [nx - x, ny - y]; x = nx; y = ny
      }
      if (loop.length > 2) loops.push(loop)
    }
  }
  return loops
}
/** Douglas-Peucker on a closed loop */
function simplify(loop, tol) {
  const n = loop.length
  if (n < 8) return loop
  let a = 0, b = 0, best = -1
  const st = Math.max(1, n >> 6)
  for (let i = 0; i < n; i += st) for (let j = i + 1; j < n; j += st) { const d = (loop[i][0] - loop[j][0]) ** 2 + (loop[i][1] - loop[j][1]) ** 2; if (d > best) { best = d; a = i; b = j } }
  const keep = new Uint8Array(n); keep[a] = keep[b] = 1
  const dp = (i, j) => {
    const p = loop[i % n], q = loop[j % n], dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1
    let far = -1, fd = tol
    for (let k = i + 1; k < j; k++) { const r = loop[k % n], d = Math.abs((r[0] - p[0]) * dy - (r[1] - p[1]) * dx) / L; if (d > fd) { fd = d; far = k } }
    if (far >= 0) { keep[far % n] = 1; dp(i, far); dp(far, j) }
  }
  dp(a, b); dp(b, a + n)
  return loop.filter((_, i) => keep[i])
}
/** the outline as vertex words (x | y << 11 | 1 << 21 where no edge leaves): each loop repeats its first vertex last */
export function outlineWords(bin, maxV = MAXV) {
  const raw = trace(bin).filter(l => l.length >= 8)
  for (let tol = 1.5; ; tol += 0.5) {
    const loops = raw.map(l => simplify(l, tol)).filter(l => l.length >= 3)
    const words = loops.flatMap(l => [...l, l[0]].map(([x, y], i, a) => x | (y << 11) | (i === a.length - 1 ? 1 << 21 : 0)))
    if (words.length <= maxV) return { words, tol, loops: loops.length }
  }
}
export const LS = 8, LW = OW / LS, LH = Math.round(OH / LS) // the shader's state texel: 8 picture pixels
/** the shader's LM after every stage: per texel parity and the nearest edge point; from the vertex words, as it reads them */
export function rasterise(words) {
  const V = words.map(w => [w & 2047, (w >> 11) & 1023, (w >> 21) & 1]), edges = []
  for (let i = 0; i + 1 < V.length; i++) if (!V[i][2]) edges.push([V[i][0], V[i][1], V[i + 1][0], V[i + 1][1]])
  const st = new Float32Array(LW * LH * 4)
  for (let j = 0; j < LH; j++) for (let i = 0; i < LW; i++) {
    const cx = (i + 0.5) * LS, cy = (j + 0.5) * LS
    let par = 0, bd = 1e9, bx = 0, by = 0
    for (const [ax, ay, ex, ey] of edges) {
      if ((ay > cy) !== (ey > cy) && cx < ax + ((cy - ay) * (ex - ax)) / (ey - ay)) par ^= 1
      const dx = ex - ax, dy = ey - ay, L2 = Math.max(dx * dx + dy * dy, 1e-6)
      const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / L2))
      const px = ax + t * dx, py = ay + t * dy, d = (cx - px) ** 2 + (cy - py) ** 2
      if (d < bd) { bd = d; bx = px; by = py }
    }
    st.set([par, bd, bx, by], (j * LW + i) * 4)
  }
  return st
}
/** signed distance (picture px, > 0 inside) at (x, y from the top), as the shader's partDist computes it */
export function partDist(st, x, y) {
  const i = Math.max(0, Math.min(LW - 1, Math.floor(x / LS))), r = Math.max(0, Math.min(LH - 1, Math.floor(y / LS)))
  const o = (r * LW + i) * 4, cx = (i + 0.5) * LS, cy = (r + 0.5) * LS, sg = st[o] > 0.5 ? 1 : -1
  const gx = (cx - st[o + 2]) * sg, gy = (cy - st[o + 3]) * sg, L = Math.hypot(gx, gy)
  return sg * Math.sqrt(st[o + 1]) + (L > 0.001 ? (gx * (x - cx) + gy * (y - cy)) / L : 0)
}
/** the playback rule (hooks/live-key.ts, LD) at picture point (X, Y): the parts' motion f and the background's b (picture
 * px) -> the displacement to show */
export function layerD(st, X, Y, f, b) {
  const sn = partDist(st, X - f[0], Y - f[1]), a = partDist(st, X, Y) + RIM + BAND
  const w = sn > -RIM ? 1 : Math.max(a > 0 ? a / Math.max(a - RIM - sn, 0.001) : 0, Math.max(0, 1 + (sn + RIM) / LEAD))
  return [b[0] + w * (f[0] - b[0]), b[1] + w * (f[1] - b[1])]
}

// --- segmentation ------------------------------------------------------------------------------------------------------
/** -> { parts: [motion-res masks], fg, bg, lines } */
function segment(frame, N, W, H, grid, say, { minArea = 0.004, iters = 3, minGain = 0.35, bias = 0.5 } = {}) {
  const S = W * H, std = stdMap(frame, N, S)
  const mov = Uint8Array.from(std, v => (v > 4 ? 1 : 0))
  const region = Uint8Array.from(blur(Float32Array.from(mov), W, H, 3), v => (v > 0.12 ? 1 : 0))
  const { lab, comps } = components(region, W, H)
  let blobs = comps.filter(c => c.n >= minArea * S).map(c => fillHoles(Uint8Array.from(lab, v => (v === c.id ? 1 : 0)), W, H))
  say(`${(100 * mov.reduce((a, b) => a + b, 0) / S).toFixed(1)}% of the picture moves; ${blobs.length} moving area(s) of at least ${(minArea * 100).toFixed(1)}% of it`)
  if (!blobs.length) return { parts: [] }
  const B = Array.from({ length: N }, (_, f) => blur(frame(f), W, H, 1)), b0 = B[0], CLIP = 24
  function errMap(Dfn) { // per pixel, the median over the loop of |frame0(q) - frame f at q + D(q)| (1/4 steps, clipped)
    const E = new Float32Array(S), h = new Int32Array(CLIP * 4 + 1), half = (N - 1) / 2
    for (let i = 0; i < S; i++) {
      const x = i % W, y = (i / W) | 0
      h.fill(0)
      for (let f = 1; f < N; f++) { const [dx, dy] = Dfn(f, x, y); h[Math.round(Math.min(CLIP, Math.abs(samp(B[f], W, H, x + dx, y + dy) - b0[i])) * 4)]++ }
      let k = 0, n = h[0]; while (n < half) n += h[++k]
      E[i] = k / 4
    }
    return E
  }
  const Est = errMap(() => [0, 0]), Egr = errMap((f, x, y) => gridD(grid, f, x, y, W, H))
  const errOf = m => errMap((f, x, y) => gridD(m, f, x, y, W, H))
  const union = bs => { const u = new Uint8Array(S); bs.forEach(m => m.forEach((v, i) => { if (v) u[i] = 1 })); return u }
  let fg, bg, Efg, t0 = Date.now()
  for (let it = 0; it < iters; it++) {
    const u = union(blobs)
    fg = fitGrid(frame, N, W, H, grid.GX, grid.GY, Float32Array.from(shrink(u, W, H, 1)))
    bg = fitGrid(frame, N, W, H, grid.GX, grid.GY, Float32Array.from(grow(u, W, H, 2), v => 1 - v))
    Efg = errOf(fg)
    const cf = blur(Efg, W, H, 1), cb = blur(errOf(bg), W, H, 1)
    blobs = blobs.map(m => {
      const zone = grow(m, W, H, 6)
      const win = Uint8Array.from(zone, (z, i) => (z && cf[i] + bias < cb[i] ? 1 : 0))
      return fillHoles(largest(Uint8Array.from(blur(Float32Array.from(win), W, H, 1), v => (v > 0.5 ? 1 : 0)), W, H), W, H)
    }).filter(m => m.reduce((a, b) => a + b, 0) >= minArea * S)
    say(`round ${it + 1} of ${iters} (${((Date.now() - t0) / 1000).toFixed(0)} s): ${blobs.length ? blobs.map((m, k) => `part ${k + 1} ${(100 * m.reduce((a, b) => a + b, 0) / S).toFixed(1)}%`).join(', ') : 'no parts left'}`)
    if (!blobs.length) return { parts: [] }
  }
  const parts = []
  for (const mask of blobs) { // a part must be explained by motion: its own warp takes away a good share of its loop error
    let n = 0, a = 0, g = 0, s = 0, cx = 0, cy = 0
    for (let i = 0; i < S; i++) if (mask[i]) { n++; a += Efg[i]; g += Egr[i]; s += Est[i]; cx += i % W; cy += (i / W) | 0 }
    const at = `(${(cx / n / W * 100).toFixed(0)}% across, ${(cy / n / H * 100).toFixed(0)}% down)`
    if (1 - a / s < minGain) { say(`dropped the moving area at ${at}: motion explains only ${(100 * (1 - a / s)).toFixed(0)}% of its change (light or colour, not movement)`); continue }
    parts.push(mask)
    say(`part ${parts.length} (${NAMES[(parts.length - 1) % NAMES.length]} in the pictures) at ${at}, ${(100 * n / S).toFixed(1)}% of the picture: loop error with no motion ${(s / n).toFixed(2)}, one shared field ${(g / n).toFixed(2)}, its own field ${(a / n).toFixed(2)}`)
  }
  // layers are for parts over a background: when the parts are most of the picture, one field fits it better
  const cover = union(parts).reduce((a, b) => a + b, 0) / S
  if (cover > 0.35) { say(`no part moves on its own over what is behind it: the moving area is ${(100 * cover).toFixed(0)}% of the picture, so the whole scene moves together and one field fits it better.`); return { parts: [] } }
  return { parts, fg, bg }
}

// --- packing -------------------------------------------------------------------------------------------------------------
/** which nodes of a GX x GY grid have a pixel (W x H) of `m` within their bilinear reach */
function nodesNear(m, W, H, GX, GY) {
  const keep = new Uint8Array(GX * GY)
  for (let i = 0; i < W * H; i++) {
    if (!m[i]) continue
    const x = i % W, y = (i / W) | 0, u = ((x + 0.5) / W) * GX - 0.5, v = ((y + 0.5) / H) * GY - 0.5
    for (const a of [Math.floor(u), Math.floor(u) + 1]) for (const b of [Math.floor(v), Math.floor(v) + 1]) if (a >= 0 && a < GX && b >= 0 && b < GY) keep[b * GX + a] = 1
  }
  return keep
}
/** grey moving-pixel error of the layered rule played from two played grids (the shader's way, at the motion frame) */
function layeredError(frame, N, W, H, std, st, bgP, fgP) {
  const base = frame(0), k = OW / W
  let e = 0, n = 0
  for (let f = 1; f < N; f++) { const cur = frame(f)
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      const i = y * W + x; if (std[i] <= 4) continue
      const b = gridD(bgP, f, x, y, W, H).map(v => v * k), g = gridD(fgP, f, x, y, W, H).map(v => v * k)
      const [dx, dy] = layerD(st, (x + 0.5) * k, (y + 0.5) * k, g, b)
      e += Math.abs(samp(base, W, H, x - dx / k, y - dy / k) - cur[i]); n++
    } }
  return n ? e / n : 0
}

// --- command line ------------------------------------------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2), work = args[0], outP = args[1]
  const opt = (k, d) => { const i = args.indexOf('--' + k); return i > 1 ? args[i + 1] : d }
  const budget = +opt('budget', 1008), maskIn = opt('mask', null), video = opt('video', null), ffmpeg = opt('ffmpeg', 'ffmpeg')
  const dir = join(work, 'layers'); mkdirSync(dir, { recursive: true })
  const lines = []; const say = s => { console.log(s); lines.push(s) }
  const W = 320, H = 190, S = W * H, { N, frame } = loadFrames(join(work, 'loop.gray'), W, H)
  const p48 = join(work, 'mot.48.json')
  if (!existsSync(p48)) {
    say('fitting the one-field motion at 48 x 28 first (the layers build on it)...')
    writeFileSync(p48, JSON.stringify(fitGrid(frame, N, W, H, 48, 28, new Float32Array(S).fill(1))))
  }
  const grid = JSON.parse(readFileSync(p48, 'utf8'))
  const ref = readFileSync(join(work, 'ref.rgb')), pic = picture(ref)
  let own, fg, bg
  if (maskIn) { // a person's mask: refit both fields on it
    own = readMask(maskIn)
    const u = new Uint8Array(S)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0; for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) s += own[(y * 4 + b) * OW + x * 4 + a] >= 0 ? 1 : 0; u[y * W + x] = s >= 8 ? 1 : 0 }
    if (!u.some(v => v)) { say(`${maskIn} has no parts painted (all black): nothing to layer.`); writeFileSync(join(dir, 'report.txt'), lines.join('\n') + '\n'); process.exit(0) }
    say(`using the mask ${maskIn} as given; fitting the two fields on it...`)
    snap(own, pic, 4, 4) // tidy a hand-painted edge without undoing the painting
    fg = fitGrid(frame, N, W, H, 48, 28, Float32Array.from(shrink(u, W, H, 1)))
    bg = fitGrid(frame, N, W, H, 48, 28, Float32Array.from(grow(u, W, H, 2), v => 1 - v))
  } else {
    const seg = segment(frame, N, W, H, grid, say)
    if (!seg.parts.length) { say('no layers: the one-field motion stays.'); writeFileSync(join(dir, 'report.txt'), lines.join('\n') + '\n'); process.exit(0) }
    fg = seg.fg; bg = seg.bg
    // outlines at 1280 x 760 from the soft masks (smooth, not 4 px steps), then snapped to the picture's edges
    const sc = OW / W, softs = seg.parts.map(p => blur(Float32Array.from(p), W, H, 1))
    own = new Int8Array(OW * OH).fill(-1)
    for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
      let best = 0.5, who = -1
      softs.forEach((s, k) => { const v = samp(s, W, H, (x + 0.5) / sc - 0.5, (y + 0.5) / sc - 0.5); if (v > best) { best = v; who = k } })
      own[y * OW + x] = who
    }
    writeMask(join(dir, 'coarse.png'), own)
    say(`snapped the outlines to the picture's edges: ${(100 * snap(own, pic, 24, 12)).toFixed(2)}% of pixels changed side`)
  }
  if (!maskIn) writeMask(join(dir, 'mask.png'), own) // a person's own mask is never rewritten
  const ov = overlay(own, pic); writePNG(join(dir, 'overlay.png'), ov.w, ov.h, ov.rgb)
  writeFileSync(join(dir, 'fg.json'), JSON.stringify(fg)); writeFileSync(join(dir, 'bg.json'), JSON.stringify(bg))
  // the outline
  const bin = Uint8Array.from(own, v => (v >= 0 ? 1 : 0))
  const ol = outlineWords(bin)
  const st = rasterise(ol.words)
  let off = 0; for (let y = 0; y < OH; y += 2) for (let x = 0; x < OW; x += 2) if ((partDist(st, x + 0.5, y + 0.5) > 0 ? 1 : 0) !== bin[y * OW + x]) off++
  say(`outline: ${ol.loops} loop(s), ${ol.words.length} vertices (${ol.words.length} words) within ${ol.tol} px; as the shader reads it back, ${(400 * off / (OW * OH)).toFixed(2)}% of pixels land on the other side`)
  // the two fields as one motion v2 block: background's 48 x 28 nodes, then the parts'
  const std = stdMap(frame, N, S)
  const both = { W, H, GX: 48, GY: 56, N, tracks: [...bg.tracks, ...fg.tracks] }
  // moving nodes: the background's where something moves outside the parts (the rule never uses it inside them), the
  // parts' within reach of them (their motion is read up to a part's move plus the bands away)
  const small = Uint8Array.from({ length: S }, (_, i) => (bin[(((i / W) | 0) * 4 + 2) * OW + (i % W) * 4 + 2] ? 1 : 0))
  const outside = grow(small, W, H, 2)
  const keep = new Uint8Array(48 * 56)
  nodesNear(Uint8Array.from(std, (v, i) => (v > 4 && !outside[i] ? 1 : 0)), W, H, 48, 28).forEach((v, n) => { keep[n] = v })
  nodesNear(grow(small, W, H, 5), W, H, 48, 28).forEach((v, n) => { keep[48 * 28 + n] = v })
  const loopMs = Math.round((N * 1000) / 12)
  let best
  for (const K of [8, 6, 5, 4, 3, 2]) for (const WB of [5, 4]) {
    const r = fit(both, std, W, H, loopMs, K, 32, WB, 8, keep)
    if (r.words > budget) continue
    const P = r.play, bgP = { ...P, GY: 28, tracks: P.tracks.slice(0, 48 * 28) }, fgP = { ...P, GY: 28, tracks: P.tracks.slice(48 * 28) }
    const e = layeredError(frame, N, W, H, std, st, bgP, fgP)
    say(`  K${K} WB${WB}: ${r.words} words, moving error ${e.toFixed(2)}`)
    if (!best || e < best.e) best = { ...r, e, bgP, fgP }
    break
  }
  if (!best) { say(`the two fields do not fit in ${budget} words: no layers (the one-field motion stays). Give motion more room with --motion-words.`); writeFileSync(join(dir, 'report.txt'), lines.join('\n') + '\n'); process.exit(0) }
  const pack = { ...best.pack, GY: 56, words: [...best.pack.words, ...ol.words], layers: { first: best.pack.words.length, count: ol.words.length, word2: (RIM * 8) << 16 | (BAND * 8) << 8 | LEAD * 8 } }
  if (pack.layers.first > 4095) throw new Error(`the motion block is ${pack.layers.first} words; the outline must start before word 4096`)
  writeFileSync(outP, JSON.stringify(pack))
  writeFileSync(outP.replace(/\.json$/, '.play.json'), JSON.stringify({ bg: best.bgP, fg: best.fgP }))
  say(`layered motion: ${pack.K} curves, ${pack.WB}-bit weights, ${pack.movers} moving nodes (${keep.slice(0, 1344).reduce((a, b) => a + b, 0)} background, ${keep.slice(1344).reduce((a, b) => a + b, 0)} parts), ${best.words} words + ${ol.words.length} outline words; moving error ${best.e.toFixed(2)}`)
  // a picture to check by eye: at the frame where the parts move most, around the largest part: real | one field | layered
  if (video) {
    let fBest = 0, mBest = -1
    for (let f = 0; f < N; f++) { let m = 0; for (let n = 0; n < 1344; n += 3) if (keep[1344 + n]) { const d = best.fgP.tracks[n].d[f]; m = Math.max(m, Math.hypot(d[0], d[1])) } if (m > mBest) { mBest = m; fBest = f } }
    let x0 = OW, y0 = OH, x1 = 0, y1 = 0
    for (let y = 0; y < OH; y += 2) for (let x = 0; x < OW; x += 2) if (bin[y * OW + x]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
    const m = 40; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(OW - 1, x1 + m); y1 = Math.min(OH - 1, y1 + m)
    let cw = x1 - x0 + 1, ch = y1 - y0 + 1; const sc = Math.min(1, 1500 / (cw * 3), 600 / ch); const pw = Math.floor(cw * sc), ph = Math.floor(ch * sc)
    const CROP = "crop='min(iw,ih*800/475)':'min(ih,iw*475/800)'"
    const r = spawnSync(ffmpeg, ['-v', 'error', '-i', video, '-vf', `fps=12,${CROP},scale=${OW}:${OH}:flags=lanczos,select='eq(n\\,${fBest})'`, '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 })
    const real = r.status === 0 && r.stdout.length >= OW * OH * 3 ? r.stdout : null
    const RW = 1920, RH = 1140, sref = (x, y) => {
      x = Math.max(0, Math.min(RW - 1.001, (x + 0.5) * 1.5 - 0.5)); y = Math.max(0, Math.min(RH - 1.001, (y + 0.5) * 1.5 - 0.5))
      const a0 = x | 0, b0 = y | 0, a = x - a0, b = y - b0, i = (b0 * RW + a0) * 3
      return [0, 1, 2].map(c => (ref[i + c] * (1 - a) + ref[i + 3 + c] * a) * (1 - b) + (ref[i + RW * 3 + c] * (1 - a) + ref[i + RW * 3 + 3 + c] * a) * b)
    }
    const one = existsSync(join(work, 'pack.play.json')) ? JSON.parse(readFileSync(join(work, 'pack.play.json'), 'utf8')) : grid
    const k = OW / W, cols = [
      (X, Y) => (real ? [...real.subarray((Y * OW + X) * 3, (Y * OW + X) * 3 + 3)] : [0, 0, 0]),
      (X, Y) => { const d = gridD(one, fBest, (X + 0.5) / k - 0.5, (Y + 0.5) / k - 0.5, W, H); return sref(X - d[0] * k, Y - d[1] * k) },
      (X, Y) => {
        const u = (X + 0.5) / k - 0.5, v = (Y + 0.5) / k - 0.5
        const D = layerD(st, X + 0.5, Y + 0.5, gridD(best.fgP, fBest, u, v, W, H).map(t => t * k), gridD(best.bgP, fBest, u, v, W, H).map(t => t * k))
        return sref(X - D[0], Y - D[1])
      }]
    const SW = pw * 3 + 8, sheet = new Uint8Array(SW * ph * 3).fill(255)
    cols.forEach((fn, c) => { for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const X = Math.min(OW - 1, x0 + Math.floor(x / sc)), Y = Math.min(OH - 1, y0 + Math.floor(y / sc)), col = fn(X, Y)
      for (let q = 0; q < 3; q++) sheet[(y * SW + c * (pw + 4) + x) * 3 + q] = Math.max(0, Math.min(255, Math.round(col[q])))
    } })
    writePNG(join(dir, 'compare.png'), SW, ph, sheet)
    say(`compare.png: loop frame ${fBest} (the parts' largest move, ${(mBest * k).toFixed(1)} px), real | one field | layered`)
  }
  writeFileSync(join(dir, 'report.txt'), lines.join('\n') + '\n')
}
