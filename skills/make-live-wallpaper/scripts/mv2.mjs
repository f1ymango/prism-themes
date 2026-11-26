// mv2.mjs: motion format v2 ("MV2") for hooks/live-key.ts: a still mask, K shared curves of any shape, per-node weights.
//   node mv2.mjs <tracks.json> <loop.gray> <w> <h> <loopMs> <out pack.json> [budget words=1008] [grid=auto|24|48]
//   tracks.json from flow2.mjs; for grid 48 (or auto) also <tracks>.48.json (flow2 at 48 x 28) when it exists.
// Picks the layout (grid, K curves, weight bits) with the least moving-pixel error that fits the budget, writes the
// pack (ka2-enc.mjs reads pack.v === 2) and <out>.play.json (the tracks as the shader plays them, for c1/measure.mjs).
//
// The model: nodes on a GX x GY grid (24 x 14 or 48 x 28) at cell centres, displacement D bilinear between them
// (clamped), a pixel shows the picture from p - D (pixels of the W x H motion frame). A node is still (D = 0) unless a
// pixel within its reach has temporal std > 4 grey levels. Moving node n: D(t) = sum_k w_nk (u_k(t) - u_k(0)), x and y
// each with their own weights. u_k: T samples a loop (CB bits), played by periodic Catmull-Rom; tt = frac(t / loop) * T.
// Block of words (motion word i lives at 16 + i for i < 1008, else at WORDS - MW + i, the stream giving those up):
//   0..K-1         scale_k * 4096 (weights are (v - L) / L * scale_k, L = 2^(WB-1) - 1, v the WB-bit field)
//   K..K+ceil(G/12)-1  mask: (moving nodes before this group) << 12 | 12 bits, the group's first node at bit 11
//   then           curves: K x T samples, CB bits each, MSB first across words; sample (v - CL) / CL, CL = 2^(CB-1) - 1
//   then           weights: per moving node in order, x weights k = 0..K-1 then y, WB bits each, MSB first
// Header (ka2-enc.mjs): word 12 'MV2' (0x4D5632), 13 = g << 19 | K << 15 | T << 8 | WB << 4 | CB (g 1 for 48 x 28),
// 14 MW (block words), 15 the moving node count.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const MV2 = 0x4d5632
const cr = (s, t) => {
  const T = s.length, i = Math.floor(t), a = t - i, p = j => s[(((i + j) % T) + T) % T]
  const p0 = p(-1), p1 = p(0), p2 = p(1), p3 = p(2)
  return 0.5 * (2 * p1 + (-p0 + p2) * a + (2 * p0 - 5 * p1 + 4 * p2 - p3) * a * a + (-p0 + 3 * p1 - 3 * p2 + p3) * a * a * a)
}

/** per-pixel temporal std of a gray loop */
export function stdMap(gray, W, H) {
  const S = W * H, F = Math.floor(gray.length / S), mu = new Float64Array(S), q = new Float64Array(S)
  for (let f = 0; f < F; f++) for (let i = 0; i < S; i++) { const v = gray[f * S + i]; mu[i] += v; q[i] += v * v }
  return Float32Array.from(mu, (m, i) => Math.sqrt(Math.max(0, q[i] / F - (m / F) ** 2)))
}

/** fit and quantise one layout; returns { pack, play, words }. keepIn: which nodes move (default: those near a pixel
 * whose temporal std is over 4; layers.mjs passes its own for its two grids). dims 2: x and y (motion); 1: x only (the
 * light term: tracks hold [light, 0], one weight set a node) */
export function fit(m, std, W, H, loopMs, K, T, WB, CB, keepIn, dims = 2) {
  const DIM = dims === 1 ? [0] : [0, 1]
  const { GX, GY, N } = m, G = GX * GY
  const keep = keepIn ? Uint8Array.from(keepIn) : new Uint8Array(G)
  for (let i = 0; i < W * H && !keepIn; i++) {
    if (std[i] <= 4) continue
    const x = i % W, y = Math.floor(i / W), u = ((x + 0.5) / W) * GX - 0.5, v = ((y + 0.5) / H) * GY - 0.5
    for (const a of [Math.floor(u), Math.floor(u) + 1]) for (const b of [Math.floor(v), Math.floor(v) + 1])
      if (a >= 0 && a < GX && b >= 0 && b < GY) keep[b * GX + a] = 1
  }
  const movers = [...keep.keys()].filter(n => keep[n])
  // principal curves of the moving nodes' tracks
  const C = Array.from({ length: N }, () => new Float64Array(N))
  for (const n of movers) for (const c of DIM) {
    const r = m.tracks[n].d.map(d => d[c])
    for (let a = 0; a < N; a++) if (r[a]) for (let b = 0; b < N; b++) C[a][b] += r[a] * r[b]
  }
  const basis = []
  for (let k = 0; k < K; k++) {
    let v = Float64Array.from({ length: N }, (_, i) => Math.sin(i * (k + 1) + 1))
    for (let it = 0; it < 300; it++) {
      const w = new Float64Array(N)
      for (let a = 0; a < N; a++) { let s = 0; for (let b = 0; b < N; b++) s += C[a][b] * v[b]; w[a] = s }
      for (const u of basis) { let d = 0; for (let i = 0; i < N; i++) d += w[i] * u[i]; for (let i = 0; i < N; i++) w[i] -= d * u[i] }
      const l = Math.hypot(...w); if (!l) break; v = w.map(x => x / l)
    }
    basis.push(v)
  }
  // curves: T box-averaged samples, quantised; played back exactly as the shader does
  const CL = (1 << (CB - 1)) - 1, WL = (1 << (WB - 1)) - 1
  const curveQ = basis.map(u => {
    const s = Array.from({ length: T }, (_, j) => {
      const c = (j * N) / T; let a = 0, n = 0
      for (let f = Math.round(c - N / T / 2); f <= Math.round(c + N / T / 2); f++) { a += u[((f % N) + N) % N]; n++ }
      return a / n
    })
    const mx = Math.max(...s.map(Math.abs)) || 1
    return s.map(v => Math.round((v / mx) * CL))
  })
  const curves = curveQ.map(q => { const s = q.map(v => v / CL); return Array.from({ length: N }, (_, f) => cr(s, (f * T) / N) - s[0]) })
  // weights: least squares on the played curves, then quantised with one scale per curve
  const A = curves.map(a => curves.map(b => a.reduce((s, v, f) => s + v * b[f], 0)))
  const solve = rhs => {
    const M = A.map((r, i) => [...r, rhs[i]]), n = K
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
      ;[M[c], M[p]] = [M[p], M[c]]
      for (let r = 0; r < n; r++) if (r !== c && M[c][c]) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k] }
    }
    return M.map((r, i) => (r[i] ? r[n] / r[i] : 0))
  }
  const Wt = movers.map(n => DIM.map(c => solve(curves.map(u => u.reduce((s, v, f) => s + v * m.tracks[n].d[f][c], 0)))))
  const scaleQ = Array.from({ length: K }, (_, k) => Math.max(1, Math.round(4096 * Math.max(...Wt.flatMap(w => w.map(row => Math.abs(row[k])))))))
  const wq = Wt.map(w => w.map(row => row.map((v, k) => Math.max(-WL, Math.min(WL, Math.round((v / (scaleQ[k] / 4096)) * WL))))))
  // played tracks
  const deq = (q, k) => (q / WL) * (scaleQ[k] / 4096)
  const play = { ...m, tracks: m.tracks.map(() => ({ d: Array.from({ length: N }, () => [0, 0]) })) }
  movers.forEach((n, r) => { for (let f = 0; f < N; f++) for (const c of DIM) play.tracks[n].d[f][c] = curves.reduce((s, u, k) => s + deq(wq[r][c][k], k) * u[f], 0) })
  // the block of words
  const bits = []
  const put = (v, b) => { for (let i = b - 1; i >= 0; i--) bits.push((v >> i) & 1) }
  const block = [...scaleQ]
  for (let g = 0; g < Math.ceil(G / 12); g++) {
    let before = 0; for (let n = 0; n < g * 12; n++) before += keep[n]
    let m12 = 0; for (let j = 0; j < 12; j++) { const n = g * 12 + j; m12 = (m12 << 1) | (n < G ? keep[n] : 0) }
    block.push((before << 12) | m12)
  }
  const flushBits = () => { for (let i = 0; i < bits.length; i += 24) { let w = 0; for (let j = 0; j < 24; j++) w = (w << 1) | (bits[i + j] ?? 0); block.push(w >>> 0) } bits.length = 0 }
  curveQ.forEach(q => q.forEach(v => put(v + CL, CB))); flushBits()
  wq.forEach(w => w.forEach(row => row.forEach(v => put(v + WL, WB)))); flushBits()
  const pack = { v: 2, GX, GY, W: m.W, H: m.H, K, T, WB, CB, loopMs, movers: movers.length, words: block }
  return { pack, play, words: block.length }
}

/** mean abs error over moving pixels (every second pixel, every frame) of a played model */
export function movingError(gray, W, H, std, m) {
  const S = W * H, F = Math.floor(gray.length / S), base = gray.subarray(0, S)
  const samp = (x, y) => {
    x = Math.max(0, Math.min(W - 1.001, x)); y = Math.max(0, Math.min(H - 1.001, y))
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * W + x0
    return (base[i] * (1 - fx) + base[i + 1] * fx) * (1 - fy) + (base[i + W] * (1 - fx) + base[i + W + 1] * fx) * fy
  }
  let e = 0, n = 0
  for (let f = 1; f < F; f++) for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const i = y * W + x; if (std[i] <= 4) continue
    const u = Math.max(0, Math.min(m.GX - 1, ((x + 0.5) / W) * m.GX - 0.5)), v = Math.max(0, Math.min(m.GY - 1, ((y + 0.5) / H) * m.GY - 0.5))
    const i0 = Math.min(m.GX - 2, Math.floor(u)), j0 = Math.min(m.GY - 2, Math.floor(v)), fu = u - i0, fv = v - j0
    const d = (a, b) => m.tracks[b * m.GX + a].d[f % m.N]
    const a = d(i0, j0), b = d(i0 + 1, j0), c = d(i0, j0 + 1), g = d(i0 + 1, j0 + 1)
    const D = [0, 1].map(k => (a[k] * (1 - fu) + b[k] * fu) * (1 - fv) + (c[k] * (1 - fu) + g[k] * fu) * fv)
    e += Math.abs(samp(x - (D[0] * W) / m.W, y - (D[1] * H) / m.H) - gray[f * S + i]); n++
  }
  return n ? e / n : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , trP, grayP, ws, hs, loopArg, outP, budgetArg = '1008', gridArg = 'auto'] = process.argv
  const W = +ws, H = +hs, gray = readFileSync(grayP), std = stdMap(gray, W, H), budget = +budgetArg
  const grids = []
  if (gridArg !== '48') grids.push(JSON.parse(readFileSync(trP, 'utf8')))
  const p48 = trP.replace(/\.json$/, '.48.json')
  if (gridArg !== '24' && existsSync(p48)) grids.push(JSON.parse(readFileSync(p48, 'utf8')))
  let best
  for (const m of grids) for (const K of [8, 6, 5, 4, 3, 2]) for (const WB of [6, 5, 4]) {
    if (m.GX > 24 && WB > 5) continue
    const r = fit(m, std, W, H, +loopArg, K, 32, WB, 8)
    if (r.words > budget) continue
    const e = movingError(gray, W, H, std, r.play)
    console.log(`  ${m.GX}x${m.GY} K${K} WB${WB}: ${r.words} words, moving error ${e.toFixed(2)}`)
    if (!best || e < best.e) best = { ...r, e }
    break // fewer weight bits only if this K did not fit
  }
  if (!best) throw new Error(`no layout fits ${budget} words`)
  writeFileSync(outP, JSON.stringify(best.pack))
  writeFileSync(outP.replace(/\.json$/, '.play.json'), JSON.stringify(best.play))
  console.log(`motion v2: ${best.pack.GX}x${best.pack.GY}, ${best.pack.K} curves, ${best.pack.WB}-bit weights, ${best.pack.movers} moving nodes, ${best.words} words, moving error ${best.e.toFixed(2)}`)
}
