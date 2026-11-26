// Per-cell 8 s loop waves -> packed ints (zigzag, companded), with the validator's cost (bit length + 1 per int).
// node quant.mjs <in.json> <out-mot.json> <H> <bits> <gamma> [packed.json]
//   env P=<loop length in frames> (default 96), FPS=<frames a second> (default 12)
import { readFileSync, writeFileSync } from 'node:fs'
const [, , inp, outp, hs, bs, gs, packOut] = process.argv
const m = JSON.parse(readFileSync(inp, 'utf8')), N = m.N, H = +hs, B = +bs, GAM = +gs, P = +(process.env.P ?? 96), FPS = +(process.env.FPS ?? 12)
const L = (1 << (B - 1)) - 1 // signed levels each side
const co = m.tracks.map(t => { const r = []
  for (let h = 1; h <= H; h++) for (const c of [0, 1]) { let a = 0, b = 0
    t.d.forEach((d, f) => { a += d[c] * Math.cos(2 * Math.PI * h * f / P); b += d[c] * Math.sin(2 * Math.PI * h * f / P) })
    r.push(2 * a / N, 2 * b / N) }
  return r }) // per cell: h1 ax bx ay by, h2 ..., h3 ...
const scale = []
for (let h = 0; h < H; h++) { let mx = 0; for (const r of co) for (let k = 0; k < 4; k++) mx = Math.max(mx, Math.abs(r[4 * h + k])); scale.push(mx) }
const enc = (v, mx) => Math.round(Math.sign(v) * Math.pow(Math.abs(v) / mx, 1 / GAM) * L)
const dec = (q, mx) => Math.sign(q) * Math.pow(Math.abs(q) / L, GAM) * mx
const zz = q => q >= 0 ? 2 * q : -2 * q - 1
let cost = 0
const ints = co.map(r => { const row = []
  for (let h = 0; h < H; h++) { let v = 0
    for (let k = 0; k < 4; k++) v = v * (1 << B) + zz(enc(r[4 * h + k], scale[h]))
    row.push(v); cost += (v ? Math.floor(Math.log2(v)) + 1 : 0) + 1 }
  return row })
const qco = co.map(r => r.map((v, i) => dec(enc(v, scale[Math.floor(i / 4)]), scale[Math.floor(i / 4)])))
const tracks = qco.map(r => { const d = Array.from({ length: N }, (_, f) => [0, 1].map(c => { let s = 0
  for (let h = 0; h < H; h++) { const ph = 2 * Math.PI * (h + 1) * f / P; s += r[4 * h + 2 * c] * Math.cos(ph) + r[4 * h + 2 * c + 1] * Math.sin(ph) }
  return s }))
  return { d: d.map(([x, y]) => [x - d[0][0], y - d[0][1]]) } })
writeFileSync(outp, JSON.stringify({ ...m, tracks }))
if (packOut) writeFileSync(packOut, JSON.stringify({ GX: m.GX, GY: m.GY, W: m.W, H: m.H, harmonics: H, bits: B, gamma: GAM, loopMs: Math.round((P * 1000) / FPS), scale, ints }))
console.log(`cost ${cost} bits for ${ints.length} cells x ${H}; scales ${scale.map(s => s.toFixed(2)).join(' ')}`)
