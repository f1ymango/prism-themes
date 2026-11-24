// /prism probe: does a colour drawn by the Svg reach the shader exactly? The Svg is a grid of cells, `n` across and
// n * 9/16 down, stretched over the window; a centred patch of up to 52 x 52 of them is coloured by a formula this file
// also knows. Each cell shows how far the colour it read is from the one drawn, in steps of 1/255:
// green exact, teal 1, yellow up to 4, orange up to 16, red more. Outside the patch the window is dimmed.
import { abs, floor, max, min, mod, picture, scene, shader, values, vec2, vec3, vec4 } from 'claude-code/shader'

const v = values({ n: [1, 1024] })

export default shader({
  fps: 30,
  passes: [
    picture(q => {
      const n = floor(v.n + 0.5)
      const h = floor(n * 0.5625 + 0.5)
      const pw = min(52, n)
      const ph = min(52, h)
      const i0 = floor((n - pw) / 2)
      const j0 = floor((h - ph) / 2)
      // the cell under this pixel, rows counted from the top like the Svg's
      const i = min(floor(q.uv.x * n), n - 1)
      const j = min(floor((1 - q.uv.y) * h), h - 1)
      const inside = i >= i0 && i < i0 + pw && j >= j0 && j < j0 + ph
      const got = scene.sample(vec2((i + 0.5) / n, 1 - (j + 0.5) / h))
      const want = vec3(mod(37 * i + 101 * j + 11, 256), mod(59 * i + 23 * j + 200, 256), mod(113 * i + 71 * j + 7, 256))
      const d = vec3(abs(vec3(got.rgb * 255 - want)))
      const err = max(d.x, max(d.y, d.z))
      const verdict = err < 0.5 ? vec3(0.1, 0.8, 0.2)
        : err < 1.5 ? vec3(0.1, 0.7, 0.75)
        : err < 4.5 ? vec3(0.95, 0.85, 0.1)
        : err < 16.5 ? vec3(0.95, 0.5, 0.1)
        : vec3(0.9, 0.1, 0.1)
      return inside ? vec4(verdict, 1) : vec4(scene.sample(q.uv).rgb * 0.25, 1)
    }),
  ],
})
