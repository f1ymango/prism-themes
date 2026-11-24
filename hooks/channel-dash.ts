// /prism channel dash (core/channel.ts): one line runs through every row of a 960 x 540 grid of units (left to right,
// then back), 963 units of path a row. Bit plane p draws it with stroke-dasharray pairs: pair k covers path
// k*1000 .. k*1000+999, on for its first dashOn(p, k) units. Each unit's colour must be exactly the planes that are on
// there. Top strip: green = every unit exact, red = some failed (white bar ~ how many); below, each unit.
import { buffer, floor, int, log, min, picture, res, scene, shader, signed, vec2, vec3, vec4, type Buffer, type int as Int } from 'claude-code/shader'

// fixed, as `once` passes may not read values: core/channel.ts draws 24 planes, period 1000
const P = 24
const per = 1000

function mix32(a: number, b: number): Int {
  let h: Int = int(int(int(a) * 739982445) ^ int(int(int(b) + 374761393) * 73244475))
  h = int(h ^ (h >>> 16))
  h = int(h * 73244475)
  h = int(h ^ (h >>> 16))
  h = int(h * 73244475)
  h = int(h ^ (h >>> 16))
  return h
}
/** x modulo r for whole numbers below 2^24, safe from rounding in the division */
function imod(x: number, r: number): number {
  const m = x - floor(x / r) * r
  return m < 0 ? m + r : m >= r ? m - r : m
}
/** the pixel centre nearest a point, so a read never blends two pixels */
const snap = (uv: vec2) => vec2((floor(uv * res) + 0.5) / res)

const W = 960
const H = 540
const ROW = 963
const err: Buffer = buffer({ size: [960, 540], float: 16, filter: 'nearest', once: true }, q => {
  const x = q.cell.x
  const y = q.cell.y
  // how far along the line this unit starts
  const s = y * ROW + (imod(y, 2) < 0.5 ? x + 1 : W - x)
  const off = imod(s, per)
  const k = (s - off) / per
  const c = scene.sample(snap(vec2((x + 0.5) / W, 1 - (y + 0.5) / H)))
  const word = int(int(floor(c.r * 255 + 0.5)) << 16) | int(int(floor(c.g * 255 + 0.5)) << 8) | int(floor(c.b * 255 + 0.5))
  let bad = 0
  for (const p of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]) {
    const want = p < P && off < 1 + imod(signed(int(mix32(p, k) >>> 12)), per - 1) ? 1 : 0
    const got = signed(int(int(word >>> (23 - p)) & 1))
    bad = bad + (want === got ? 0 : 1)
  }
  return vec4(bad > 0 ? 1 : 0, 0, 0, 1)
})
const r1: Buffer = buffer({ size: [120, 68], float: 32, filter: 'nearest', once: true }, q => {
  let s = 0
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    const y = q.cell.y * 8 + j
    s = s + (y < H ? err.at(vec2(q.cell.x * 8 + i, y)).x : 0)
  }
  return vec4(s, 0, 0, 1)
})
const r2: Buffer = buffer({ size: [15, 9], float: 32, filter: 'nearest', once: true }, q => {
  let s = 0
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    const y = q.cell.y * 8 + j
    s = s + (y < 68 ? r1.at(vec2(q.cell.x * 8 + i, y)).x : 0)
  }
  return vec4(s, 0, 0, 1)
})
const total: Buffer = buffer({ size: [1, 1], float: 32, filter: 'nearest', once: true }, () => {
  let s = 0
  for (let j = 0; j < 9; j++) for (let i = 0; i < 15; i++) s = s + r2.at(vec2(i, j)).x
  return vec4(s, 0, 0, 1)
})

export default shader({
  fps: 30,
  passes: [err, r1, r2, total, picture(q => {
    if (q.uv.y > 0.95) {
      const n = total.at(vec2(0, 0)).x
      const bar = q.uv.x < min(1, log(n + 1) / log(1000000)) && q.uv.y > 0.97
      return vec4(bar ? vec3(1) : n > 0.5 ? vec3(0.85, 0.1, 0.1) : vec3(0.1, 0.75, 0.2), 1)
    }
    const e = err.at(vec2(min(floor(q.uv.x * W), W - 1), min(floor((1 - q.uv.y) * H), H - 1))).x
    return vec4(e > 0.5 ? vec3(0.95, 0.1, 0.1) : vec3(0.05, 0.3, 0.1), 1)
  })],
})
