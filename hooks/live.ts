// The live wallpaper player for any theme: the Svg carries both the picture and its motion, so this one file plays
// every wallpaper the converter (notes/live-converter/live-svg.mjs) makes.
//
// The Svg is stretched over the window (preserveAspectRatio none). Its bottom 1/240 is a data strip: 64 cells and a
// clock cell, side by side. For a moment k of 16 the clock shows #A5 then k in green and blue, and each cell shows a
// 24-bit word (SMIL, discrete). This file copies each moment into `acc` as it passes, so after one run of the strip
// it holds 1024 words:
//   0      'PRL' (0x50524C), a mark that the strip is ours
//   1..3   each wave term's scale * 65536 (pixels of the motion frame for a field of 31)
//   4      the loop's length in ms
//   5      the picture's width / height * 1e6
//   6, 7   the motion frame's width and height in pixels
//   16..   per grid point (24 x 14, row 0 at the top), per wave term 1..3: one word of four 6-bit zigzag fields,
//          x cos, x sin, y cos, y sin (a pixel shows the picture from p - D, D = sum a (cos hwt - 1) + b sin hwt)
// Until every word is in, the picture stands still. The picture is smoothed once (edge-keeping), shown cropped to
// fill the window, and moved by the grid.
import { cos, dot, exp, floor, int, max, min, picture, buffer, res, scene, shader, signed, sin, size, still, time, values, vec2, vec3, vec4, type Buffer, type int as Int } from 'claude-code/shader'

/** the share of the Svg's height the data strip takes, at the bottom */
const STRIP = 1 / 240
const CELLS = 64
const MOMENTS = 16
// /prism livedebug: 1 draws what the shader reads over the top of the window
const v = values({ debug: [0, 1] })

/**
 * The middle of strip cell i (64 is the clock). Not snapped to pixels: in a buffer pass `res` is the buffer's size,
 * not the window's. A cell is ~29 x 4.5 px at 1920 x 1080, so a read at its middle blends only pixels of that cell.
 */
const cellAt = (i: number) => vec2((i + 0.5) / (CELLS + 1), STRIP * 0.5)
const word = (c: vec4): Int =>
  int(int(int(floor(c.r * 255 + 0.5)) << 16) | int(int(floor(c.g * 255 + 0.5)) << 8) | int(floor(c.b * 255 + 0.5)))

// the words, a row a moment; alpha 1 once seen
const acc: Buffer = buffer({ size: [64, 16], filter: 'nearest' }, q => {
  const old = acc.at(q.cell)
  const clock = scene.sample(cellAt(CELLS))
  const ours = floor(clock.r * 255 + 0.5) === 165
  const now = floor(clock.g * 255 + 0.5) * 256 + floor(clock.b * 255 + 0.5)
  return ours && now === q.cell.y && old.a < 0.5 ? vec4(scene.sample(cellAt(q.cell.x)).rgb, 1) : old
})
const at = (s: number): Int => word(acc.at(vec2(s - floor(s / CELLS) * CELLS, floor(s / CELLS))))
const seen8: Buffer = buffer({ size: [8, 2], float: 32, filter: 'nearest' }, q => {
  let n = 0
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) n = n + acc.at(vec2(q.cell.x * 8 + i, q.cell.y * 8 + j)).a
  return vec4(n, 0, 0, 1)
})
// x: 1 when every word is in and the mark is right; y: words seen; z: 1 when the mark is right
const ready: Buffer = buffer({ size: [1, 1], float: 32, filter: 'nearest' }, () => {
  let n = 0
  for (let j = 0; j < 2; j++) for (let i = 0; i < 8; i++) n = n + seen8.at(vec2(i, j)).x
  const mark = signed(at(0)) === 5263948 ? 1 : 0
  return vec4(n > CELLS * MOMENTS - 0.5 && mark > 0.5 ? 1 : 0, n, mark, 1)
})

// a zigzag 6-bit field of a word as a whole number from -31 to 31
const field = (v: Int, shift: number) => {
  const z = int((v >> shift) & 63)
  return signed(int((z >> 1) ^ (0 - (z & 1))))
}

// where every grid point has swayed to by now, as fractions of the picture (row 0 at the bottom)
const sway: Buffer = buffer({ size: [24, 14], float: 16, filter: 'linear', wrap: 'clamp' }, q => {
  const n = (13 - q.cell.y) * 24 + q.cell.x
  const loop = max(signed(at(4)), 1000) / 1000
  const fw = max(signed(at(6)), 1)
  const fh = max(signed(at(7)), 1)
  // Reduce Motion holds it at the start
  const ph = time * (1 - still) * 6.2831853 / loop
  let dx = 0
  let dy = 0
  for (const h of [1, 2, 3]) {
    const w = at(16 + n * 3 + h - 1)
    const k = signed(at(h)) / 65536 / 31
    const c = cos(ph * h) - 1
    const s = sin(ph * h)
    dx = dx + (field(w, 18) * c + field(w, 12) * s) * k / fw
    dy = dy + (field(w, 6) * c + field(w, 0) * s) * k / fh
  }
  const on = ready.at(vec2(0, 0)).x
  return vec4(dx * on, dy * on, 0, 1)
})

// the picture's part of the scene: y from the top of the strip up
const lowest = (uv: vec2) => vec2(uv.x, max(uv.y, STRIP + 1 / res.y))
// edge-keeping blur: neighbours of a like colour mix, a strong edge stays
const R = 8 / 1600
const smooth = (read: (uv: vec2) => vec4, uv: vec2) => {
  const c0 = read(lowest(uv))
  let sum = vec4(0)
  let w = 0
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      const c = read(lowest(vec2(uv + vec2(x, y) * (R * res.x / 2) / res)))
      const d = vec4(c - c0)
      const k = exp(0 - dot(d.rgb, d.rgb) / 0.0081 - (x * x + y * y) / 2.4)
      sum = vec4(sum + c * k)
      w = w + k
    }
  }
  return vec4(sum / w)
}
const soft1: Buffer = buffer({ once: true }, q => smooth(uv => scene.sample(uv), q.uv))
const soft2: Buffer = buffer({ once: true }, q => smooth(uv => soft1.sample(uv), q.uv))

export default shader({
  fps: 30,
  passes: [acc, seen8, ready, sway, soft1, soft2, picture(q => {
    // the window shows the picture centred and cropped to fill
    const pa = signed(at(5)) / 1000000
    const a = pa > 0.1 ? pa : 1.684
    const aspect = size.x / size.y
    const fx = min(1, aspect / a)
    const fy = min(1, a / aspect)
    const pic = vec2(0.5 + (q.uv.x - 0.5) * fx, 0.5 + (q.uv.y - 0.5) * fy)
    // the pixel shows the picture where that bit of it was at the start
    const d = sway.sample(pic)
    const from = vec2(pic.x - d.x, pic.y + d.y)
    const shown = soft2.sample(vec2(from.x, STRIP + from.y * (1 - STRIP))).rgb
    if (v.debug < 0.5 || q.uv.y < 0.86) return vec4(shown, 1)
    // debug, top down: the bottom 1% of the scene as drawn (the strip is its lower 42%); words seen (green, orange
    // while the mark is wrong) with the clock as read at the right (white tick when it is ours); cell 0 of each of
    // the 16 moments (green = seen)
    if (q.uv.y > 0.94) return vec4(scene.sample(vec2(q.uv.x, (q.uv.y - 0.94) / 0.06 * 0.01)).rgb, 1)
    const r = ready.at(vec2(0, 0))
    if (q.uv.y > 0.9) {
      const clock = scene.sample(cellAt(CELLS))
      if (q.uv.x > 0.9) return vec4(clock.rgb, 1)
      if (q.uv.x > 0.88) return vec4(vec3(floor(clock.r * 255 + 0.5) === 165 ? 1 : 0.1), 1)
      return vec4(q.uv.x / 0.88 < r.y / (CELLS * MOMENTS) ? (r.z > 0.5 ? vec3(0.1, 0.8, 0.2) : vec3(1, 0.5, 0)) : vec3(0.15), 1)
    }
    const k = min(floor(q.uv.x * MOMENTS), MOMENTS - 1)
    return vec4(acc.at(vec2(0, k)).a > 0.5 ? vec3(0.1, 0.8, 0.2) : vec3(0.3, 0, 0), 1)
  })],
})
