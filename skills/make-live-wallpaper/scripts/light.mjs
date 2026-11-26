// light.mjs: the light term of motion v2. What the played warp leaves is often a change of brightness (light sweeping,
// glare, shadows), which no warp of the keyframe can draw: warping only bends things trying. This fits it as an
// additive grey offset on a 24 x 14 grid of its own, in MV2's form (K shared curves, a mask, per-node weights), and
// keeps it only when it pays for its words. (The shader keeps those nodes in a corner of its motion buffer that layered
// 48 x 28 motion fills, so that one layout has no light.)
//   node light.mjs <pack.json> <loop.gray> <w> <h> <out pack.json> [budget words=400] [report.png]
// Reads <pack>.play.json beside the pack (the warp as the shader plays it). Writes <out> = the pack plus `light`
// ({ K, T, WB, CB, words }) when kept, else the pack unchanged, and <out>.light-play.json (the light as played: tracks
// [node][frame] in grey levels, for the simulator check); prints the moving error with and without it.
// Model: a pixel shows warp(p) + L(p, t) / 255 in every channel; L bilinear between the nodes (clamped, as the motion);
// node n: L(t) = sum_k w_nk (u_k(t) - u_k(0)), so frame 0 is the keyframe exactly. Block words (as mv2.mjs, x weights
// only): K scales, the mask, the curves, then K weights a lit node. ka2-enc.mjs puts them after the motion block and
// word 3 = 1 << 23 | K << 20 | WB << 16 | CB << 12 | first block word.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fit, stdMap } from './mv2.mjs'

/** bilinear weights of pixel (x, y) of a W x H frame on a GX x GY node grid, clamped to the outer nodes */
export function tent(GX, GY, W, H, x, y) {
  const u = Math.max(0, Math.min(GX - 1, ((x + 0.5) / W) * GX - 0.5)), v = Math.max(0, Math.min(GY - 1, ((y + 0.5) / H) * GY - 0.5))
  const i0 = Math.min(GX - 2, Math.floor(u)), j0 = Math.min(GY - 2, Math.floor(v)), fu = u - i0, fv = v - j0
  return [[j0 * GX + i0, (1 - fu) * (1 - fv)], [j0 * GX + i0 + 1, fu * (1 - fv)], [(j0 + 1) * GX + i0, (1 - fu) * fv], [(j0 + 1) * GX + i0 + 1, fu * fv]]
}

/** every frame of the loop as the played model draws it (grey, motion frame size) */
export function playWarp(gray, W, H, play) {
  const S = W * H, F = play.N, base = gray.subarray(0, S), out = new Float32Array(F * S)
  const samp = (x, y) => {
    x = Math.max(0, Math.min(W - 1.001, x)); y = Math.max(0, Math.min(H - 1.001, y))
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * W + x0
    return (base[i] * (1 - fx) + base[i + 1] * fx) * (1 - fy) + (base[i + W] * (1 - fx) + base[i + W + 1] * fx) * fy
  }
  const T = []; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) T.push(tent(play.GX, play.GY, W, H, x, y))
  for (let f = 0; f < F; f++) for (let i = 0; i < S; i++) {
    let dx = 0, dy = 0
    for (const [n, w] of T[i]) { const d = play.tracks[n].d[f]; dx += w * d[0]; dy += w * d[1] }
    out[f * S + i] = samp((i % W) - (dx * W) / play.W, Math.floor(i / W) - (dy * H) / play.H)
  }
  return out
}

/** per-frame light at the nodes of a GX x GY grid: least squares by rounds of tent-weighted averages of what is left */
export function lightTracks(gray, warp, W, H, F, GX, GY) {
  const S = W * H, G = GX * GY, T = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) T.push(tent(GX, GY, W, H, x, y))
  const l = Array.from({ length: F }, () => new Float64Array(G))
  for (let f = 1; f < F; f++) for (let round = 0; round < 6; round++) {
    const num = new Float64Array(G), den = new Float64Array(G)
    for (let i = 0; i < S; i++) {
      let rec = 0; for (const [n, w] of T[i]) rec += w * l[f][n]
      const r = gray[f * S + i] - warp[f * S + i] - rec
      for (const [n, w] of T[i]) { num[n] += w * r; den[n] += w }
    }
    for (let n = 0; n < G; n++) if (den[n]) l[f][n] += num[n] / den[n]
  }
  return { l, T }
}

/** moving-pixel MAE (every second pixel, frames 1..) of warp + light; tr = light tracks [node][frame] or null */
export function lightError(gray, warp, W, H, F, std, T, tr) {
  const S = W * H; let e = 0, n = 0
  for (let f = 1; f < F; f++) for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const i = y * W + x; if (std[i] <= 4) continue
    let L = 0; if (tr) for (const [k, w] of T[i]) L += w * tr[k][f]
    e += Math.abs(warp[f * S + i] + L - gray[f * S + i]); n++
  }
  return n ? e / n : 0
}

export const LGX = 24, LGY = 14
/** fit the light (24 x 14); returns { light, e0, e, words, lit, tried, played } (light null when
 * it does not pay: 1000 words must buy a tenth of the warp's error) */
export function fitLight(gray, W, H, pack, play, budget = 400, thr = 3) {
  const F = play.N, std = stdMap(gray, W, H), warp = playWarp(gray, W, H, play)
  const GX = LGX, GY = LGY, G = GX * GY
  const { l, T } = lightTracks(gray, warp, W, H, F, GX, GY)
  const e0 = lightError(gray, warp, W, H, F, std, T, null), lambda = e0 / 10000
  const keep = Array.from({ length: G }, (_, n) => (l.some(lf => Math.abs(lf[n]) > thr) ? 1 : 0))
  const lit = keep.reduce((a, b) => a + b, 0)
  const tried = []
  let best = { light: null, e: e0, words: 0, score: e0, played: null }
  if (lit) {
    const m = { W, H, GX, GY, N: F, tracks: Array.from({ length: G }, (_, n) => ({ d: l.map(lf => [lf[n], 0]) })) }
    for (const K of [2, 3, 4]) for (const WB of [4, 5]) {
      const r = fit(m, std, W, H, pack.loopMs, K, 32, WB, 8, keep, 1)
      if (r.words > budget) continue
      const tr = r.play.tracks.map(t => t.d.map(d => d[0]))
      const e = lightError(gray, warp, W, H, F, std, T, tr), score = e + lambda * r.words
      tried.push({ K, WB, words: r.words, e })
      if (score < best.score) best = { light: { K, T: 32, WB, CB: 8, words: r.pack.words }, e, words: r.words, score, played: tr }
    }
  }
  return { ...best, e0, lit, G, tried, warp, T }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , packP, grayP, ws, hs, outP, budgetArg = '400', pngP] = process.argv
  const W = +ws, H = +hs, gray = readFileSync(grayP)
  const pack = JSON.parse(readFileSync(packP, 'utf8')), play = JSON.parse(readFileSync(packP.replace(/\.json$/, '.play.json'), 'utf8'))
  if (pack.v !== 2) throw new Error('the light term needs motion v2')
  if (pack.layers && pack.GX > 24) { console.log('light: layered 48 x 28 motion leaves no room for it: left out'); writeFileSync(outP, JSON.stringify(pack)); process.exit(0) }
  const r = fitLight(gray, W, H, pack, play, +budgetArg)
  for (const t of r.tried) console.log(`  K${t.K} WB${t.WB}: ${t.words} words, moving error ${t.e.toFixed(2)}`)
  console.log(`light: ${r.lit} of ${r.G} nodes change by more than 3 grey levels; moving error ${r.e0.toFixed(2)} without light, ` +
    (r.light ? `${r.e.toFixed(2)} with it (${r.light.K} curves, ${r.light.WB}-bit weights, ${r.words} words): kept` : 'not worth its words: left out'))
  writeFileSync(outP, JSON.stringify(r.light ? { ...pack, light: r.light } : pack))
  if (r.light) writeFileSync(outP.replace(/.json$/, '.light-play.json'), JSON.stringify({ GX: LGX, GY: LGY, N: play.N, tracks: r.played }))
  if (pngP) { // middle frame: real | warp | warp + light, grey, 2x
    const { writePNG } = await import('./png.mjs')
    const S = W * H, f = Math.floor(play.N / 2), OW = W * 3 * 2, out = Buffer.alloc(OW * H * 2)
    for (let i = 0; i < S; i++) {
      let L = 0; if (r.played) for (const [k, w] of r.T[i]) L += w * r.played[k][f]
      const v = [gray[f * S + i], r.warp[f * S + i], r.warp[f * S + i] + L], x = i % W, y = Math.floor(i / W)
      v.forEach((c, col) => { for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) out[(y * 2 + a) * OW + (col * W + x) * 2 + b] = Math.max(0, Math.min(255, Math.round(c))) })
    }
    writePNG(pngP, OW, H * 2, out, 1)
  }
}
