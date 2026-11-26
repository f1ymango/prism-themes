// Fit, for every frame, the grid warp of frame 0 that best rebuilds that frame (the very model the shader plays).
// Coarse to fine on blurred copies, robust to hair crossing things, each frame starting from the last one's answer.
// node flow2.mjs <frames.gray> <w> <h> <out.json> [gx] [gy]
import { readFileSync, writeFileSync } from 'node:fs'

const [, , path, ws, hs, out, gxs, gys] = process.argv
const W = +ws, H = +hs, GX = +(gxs ?? 32), GY = +(gys ?? 18)
const raw = readFileSync(path)
const N = raw.length / (W * H)
const frame = f => Float32Array.from(raw.subarray(f * W * H, (f + 1) * W * H))

function blur(src, r) {
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
const LEVELS = [4, 2, 1, 0]
const base = frame(0)
const base_s = LEVELS.map(r => blur(base, r))

// bilinear weights of each pixel onto the grid, precomputed
const nodeOf = new Int32Array(W * H * 4), wOf = new Float32Array(W * H * 4)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const u = Math.max(0, Math.min(GX - 1, (x + 0.5) / W * GX - 0.5)), v = Math.max(0, Math.min(GY - 1, (y + 0.5) / H * GY - 0.5))
  const i0 = Math.min(GX - 2, Math.floor(u)), j0 = Math.min(GY - 2, Math.floor(v)), fu = u - i0, fv = v - j0
  const p = (y * W + x) * 4
  nodeOf[p] = j0 * GX + i0; wOf[p] = (1 - fu) * (1 - fv)
  nodeOf[p + 1] = j0 * GX + i0 + 1; wOf[p + 1] = fu * (1 - fv)
  nodeOf[p + 2] = (j0 + 1) * GX + i0; wOf[p + 2] = (1 - fu) * fv
  nodeOf[p + 3] = (j0 + 1) * GX + i0 + 1; wOf[p + 3] = fu * fv
}
const G = GX * GY
const sampleG = (img, x, y, out) => {
  x = Math.max(0, Math.min(W - 1.001, x)); y = Math.max(0, Math.min(H - 1.001, y))
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * W + x0
  const a = img[i], b = img[i + 1], c = img[i + W], d = img[i + W + 1]
  out[0] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
  out[1] = (b - a) * (1 - fy) + (d - c) * fy
  out[2] = (c - a) * (1 - fx) + (d - b) * fx
}
const D = new Float64Array(G * 2)
const all = [Array.from(D)]
const tmp = new Float64Array(3)
let errSum = 0
for (let f = 1; f < N; f++) {
  const cur = frame(f)
  for (let li = 0; li < LEVELS.length; li++) {
    const ref = base_s[li], img = blur(cur, LEVELS[li])
    const iters = li === LEVELS.length - 1 ? 6 : 10
    for (let it = 0; it < iters; it++) {
      const A = new Float64Array(G * 3), b = new Float64Array(G * 2)
      let e = 0
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4
        let dx = 0, dy = 0
        for (let k = 0; k < 4; k++) { const n = nodeOf[p + k], w = wOf[p + k]; dx += w * D[2 * n]; dy += w * D[2 * n + 1] }
        sampleG(ref, x - dx, y - dy, tmp)
        const r = tmp[0] - img[y * W + x]
        const rob = 1 / Math.max(1, Math.abs(r) / 12) // Huber
        e += Math.abs(r)
        // r(d) = ref(x - d) - img: dr/dd = -grad
        const gx = -tmp[1], gy = -tmp[2]
        for (let k = 0; k < 4; k++) {
          const n = nodeOf[p + k], w = wOf[p + k] * Math.sqrt(rob)
          A[3 * n] += w * w * gx * gx; A[3 * n + 1] += w * w * gx * gy; A[3 * n + 2] += w * w * gy * gy
          b[2 * n] += w * w * gx * r; b[2 * n + 1] += w * w * gy * r
        }
      }
      if (li === LEVELS.length - 1 && it === iters - 1) errSum += e / (W * H)
      // each node: (A + mu) delta = -b + mu * (neighbours' mean - D), then a small step limit
      const mu = 400 + 0.15 * (W * H / G) * 4
      const ND = new Float64Array(D)
      for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
        const n = j * GX + i
        let mx = 0, my = 0, c = 0
        for (const [a2, b2] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) if (a2 >= 0 && a2 < GX && b2 >= 0 && b2 < GY) { mx += D[2 * (b2 * GX + a2)]; my += D[2 * (b2 * GX + a2) + 1]; c++ }
        mx = mx / c - D[2 * n]; my = my / c - D[2 * n + 1]
        const a11 = A[3 * n] + mu, a12 = A[3 * n + 1], a22 = A[3 * n + 2] + mu
        const r1 = -b[2 * n] + mu * mx, r2 = -b[2 * n + 1] + mu * my
        const det = a11 * a22 - a12 * a12
        let sx = (a22 * r1 - a12 * r2) / det, sy = (a11 * r2 - a12 * r1) / det
        const m = Math.hypot(sx, sy), cap = 1 + LEVELS[li]
        if (m > cap) { sx *= cap / m; sy *= cap / m }
        ND[2 * n] += sx; ND[2 * n + 1] += sy
      }
      D.set(ND)
    }
  }
  all.push(Array.from(D, v => +v.toFixed(2)))
  if (f % 48 === 0) console.log(`frame ${f}: mean abs error ${(errSum / f).toFixed(2)}`)
}
writeFileSync(out, JSON.stringify({ W, H, GX, GY, N, tracks: Array.from({ length: G }, (_, n) => ({ d: all.map(F => [F[2 * n], F[2 * n + 1]]) })) }))
