// /prism channel bars-fine (core/channel.ts): a W x H grid of units; bit plane p holds a bar in every column,
// height barHeight(p, column). Each unit's colour must be exactly the planes whose bar covers it. The top strip is the
// verdict for the whole Svg: green = every unit exact, red = some failed (the white bar grows with how many); below,
// each unit green or red.
import { buffer, floor, int, log, min, picture, res, scene, shader, signed, vec2, vec3, vec4, type Buffer, type int as Int } from 'claude-code/shader'

// fixed, as `once` passes may not read values: core/channel.ts draws 23 planes at H 540 (22 at H 1000, channel-bars-fine.ts)
const H = 1000
const P = 22

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
const err: Buffer = buffer({ size: [960, 1000], float: 16, filter: 'nearest', once: true }, q => {
  const x = q.cell.x
  const y = q.cell.y
  const c = scene.sample(snap(vec2((x + 0.5) / W, 1 - (y + 0.5) / H)))
  const word = int(int(floor(c.r * 255 + 0.5)) << 16) | int(int(floor(c.g * 255 + 0.5)) << 8) | int(floor(c.b * 255 + 0.5))
  let bad = 0
  for (const p of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]) {
    const want = p < P && y < imod(signed(int(mix32(p, x) >>> 12)), H + 1) ? 1 : 0
    const got = signed(int(int(word >>> (23 - p)) & 1))
    bad = bad + (want === got ? 0 : 1)
  }
  return vec4(y < H && bad > 0 ? 1 : 0, 0, 0, 1)
})
// sums of 8 x 8 blocks, twice, then all of it
const r1: Buffer = buffer({ size: [120, 125], float: 32, filter: 'nearest', once: true }, q => {
  let s = 0
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) s = s + err.at(vec2(q.cell.x * 8 + i, q.cell.y * 8 + j)).x
  return vec4(s, 0, 0, 1)
})
const r2: Buffer = buffer({ size: [15, 16], float: 32, filter: 'nearest', once: true }, q => {
  let s = 0
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    const x = q.cell.x * 8 + i
    const y = q.cell.y * 8 + j
    s = s + (y < 125 ? r1.at(vec2(x, y)).x : 0)
  }
  return vec4(s, 0, 0, 1)
})
const total: Buffer = buffer({ size: [1, 1], float: 32, filter: 'nearest', once: true }, () => {
  let s = 0
  for (let j = 0; j < 16; j++) for (let i = 0; i < 15; i++) s = s + r2.at(vec2(i, j)).x
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
