// /prism channel palette (core/channel.ts): a 192 x 108 grid of cells, the first `rows` rows coloured from a palette
// of 16 (one path a colour). Each cell must read exactly its colour. Top strip: green = every cell exact, red = some
// failed (white bar ~ how many); below, each cell green or red (grey: rows the budget left out).
import { buffer, floor, int, log, min, picture, res, scene, shader, signed, values, vec2, vec3, vec4, type Buffer, type int as Int } from 'claude-code/shader'

const v = values({ w: [0, 1023], h: [0, 1023], rows: [0, 1023] })

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

const W = 192
const H = 108
const err: Buffer = buffer({ size: [192, 108], float: 16, filter: 'nearest' }, q => {
  const R = floor(v.rows + 0.5)
  const x = q.cell.x
  const y = q.cell.y
  const c = scene.sample(snap(vec2((x + 0.5) / W, 1 - (y + 0.5) / H)))
  const word = int(int(floor(c.r * 255 + 0.5)) << 16) | int(int(floor(c.g * 255 + 0.5)) << 8) | int(floor(c.b * 255 + 0.5))
  const idx = int(int(mix32(x, y + 4096) >>> 12) & 15)
  const want = int(mix32(signed(idx), 77777) >>> 8)
  return vec4(y < R && signed(word) !== signed(want) ? 1 : 0, 0, 0, 1)
})
const r1: Buffer = buffer({ size: [24, 14], float: 32, filter: 'nearest' }, q => {
  let s = 0
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    const y = q.cell.y * 8 + j
    s = s + (y < H ? err.at(vec2(q.cell.x * 8 + i, y)).x : 0)
  }
  return vec4(s, 0, 0, 1)
})
const total: Buffer = buffer({ size: [1, 1], float: 32, filter: 'nearest' }, () => {
  let s = 0
  for (let j = 0; j < 14; j++) for (let i = 0; i < 24; i++) s = s + r1.at(vec2(i, j)).x
  return vec4(s, 0, 0, 1)
})

export default shader({
  fps: 30,
  passes: [err, r1, total, picture(q => {
    if (q.uv.y > 0.95) {
      const n = total.at(vec2(0, 0)).x
      const bar = q.uv.x < min(1, log(n + 1) / log(1000000)) && q.uv.y > 0.97
      return vec4(bar ? vec3(1) : n > 0.5 ? vec3(0.85, 0.1, 0.1) : vec3(0.1, 0.75, 0.2), 1)
    }
    const y = min(floor((1 - q.uv.y) * H), H - 1)
    const e = err.at(vec2(min(floor(q.uv.x * W), W - 1), y)).x
    return vec4(y >= floor(v.rows + 0.5) ? vec3(0.2) : e > 0.5 ? vec3(0.95, 0.1, 0.1) : vec3(0.05, 0.3, 0.1), 1)
  })],
})
