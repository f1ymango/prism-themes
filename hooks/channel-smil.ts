// /prism channel smil (core/channel.ts): 128 data cells (16 x 8 units of a 160 x 90 viewBox) animate their fill
// through 110 moments (SMIL, discrete); the clock cell at (0, 8) shows the moment's number in green and blue. Each
// frame, the shader reads the clock and copies the 128 cells into that moment's row of `acc`, which keeps them:
// alpha 1 = seen, 0.5 = seen with two different colours (a torn or blended frame), 0 = not yet.
// Picture: one square a (cell, moment): grey = not yet, green = exact, red = wrong, magenta = read two ways.
// Top strip: how many have arrived (green width), red if any is wrong, magenta if any was read two ways.
import { abs, buffer, floor, int, max, min, picture, res, scene, shader, signed, vec2, vec3, vec4, type Buffer, type int as Int } from 'claude-code/shader'

function mix32(a: number, b: number): Int {
  let h: Int = int(int(int(a) * 739982445) ^ int(int(int(b) + 374761393) * 73244475))
  h = int(h ^ (h >>> 16))
  h = int(h * 73244475)
  h = int(h ^ (h >>> 16))
  h = int(h * 73244475)
  h = int(h ^ (h >>> 16))
  return h
}
/** the pixel centre nearest a point, so a read never blends two pixels */
const snap = (uv: vec2) => vec2((floor(uv * res) + 0.5) / res)
/** the middle of the 1-unit square at (x, y) of the 160 x 90 viewBox, in uv */
const unit = (x: number, y: number) => snap(vec2((x + 0.5) / 160, 1 - (y + 0.5) / 90))

const N = 128
const M = 110
const acc: Buffer = buffer({ size: [128, 110], filter: 'nearest' }, q => {
  const i = q.cell.x
  const k = q.cell.y
  const old = acc.at(q.cell)
  const clock = scene.sample(unit(0, 8))
  const now = floor(clock.g * 255 + 0.5) * 256 + floor(clock.b * 255 + 0.5)
  const fresh = clock.r < 0.5 / 255 && now === k
  const got = scene.sample(unit(i - floor(i / 16) * 16, floor(i / 16)))
  const same = max(abs(got.r - old.r), max(abs(got.g - old.g), abs(got.b - old.b))) < 0.5 / 255
  const a = old.a < 0.25 ? 1 : old.a < 0.75 ? 0.5 : same ? 1 : 0.5
  return fresh ? vec4(old.a < 0.25 ? got.rgb : old.rgb, a) : old
})
/** per (cell, moment): seen, wrong, read two ways */
function judge(i: number, k: number): vec3 {
  const c = acc.at(vec2(i, k))
  const word = int(int(floor(c.r * 255 + 0.5)) << 16) | int(int(floor(c.g * 255 + 0.5)) << 8) | int(floor(c.b * 255 + 0.5))
  const want = int(mix32(i + 8192, k) >>> 8)
  const seen = c.a > 0.25 ? 1 : 0
  return vec3(seen, seen > 0.5 && signed(word) !== signed(want) ? 1 : 0, c.a > 0.25 && c.a < 0.75 ? 1 : 0)
}
const r1: Buffer = buffer({ size: [16, 14], float: 32, filter: 'nearest' }, q => {
  let s = vec3(0)
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    const k = q.cell.y * 8 + j
    s = vec3(s + (k < M ? judge(q.cell.x * 8 + i, k) : vec3(0)))
  }
  return vec4(s, 1)
})
const total: Buffer = buffer({ size: [1, 1], float: 32, filter: 'nearest' }, () => {
  let s = vec3(0)
  for (let j = 0; j < 14; j++) for (let i = 0; i < 16; i++) s = vec3(s + r1.at(vec2(i, j)).rgb)
  return vec4(s, 1)
})

export default shader({
  fps: 30,
  passes: [acc, r1, total, picture(q => {
    if (q.uv.y > 0.95) {
      const t = total.at(vec2(0, 0))
      const done = q.uv.x < t.r / (N * M)
      const base = t.g > 0.5 ? vec3(0.85, 0.1, 0.1) : t.b > 0.5 ? vec3(0.8, 0.1, 0.8) : vec3(0.1, 0.75, 0.2)
      return vec4(done ? base : vec3(0.15), 1)
    }
    const j = judge(min(floor(q.uv.x * N), N - 1), min(floor((0.95 - q.uv.y) / 0.95 * M), M - 1))
    const col = j.x < 0.5 ? vec3(0.2) : j.y > 0.5 ? vec3(0.95, 0.1, 0.1) : j.z > 0.5 ? vec3(0.8, 0.1, 0.8) : vec3(0.1, 0.6, 0.2)
    return vec4(col, 1)
  })],
})
