// A test scene for the official GPU backdrop: the Svg under it, rippled like water, with a soft light that follows
// the pointer. /prism shadertest on|off. Kept small: it only shows whether this Claude Desktop plays shaders.
import { cos, length, picture, pointer, pointerCount, scene, shader, sin, still, time, vec2, vec3, vec4 } from 'claude-code/shader'

export default shader({
  fps: 60,
  passes: [
    picture(p => {
      const t = time * (1 - still)
      const wave = vec2(sin(p.uv.y * 14 + t * 1.6), cos(p.uv.x * 11 + t * 1.3)) * 0.01
      const base = scene.sample(vec2(p.uv + wave))
      const aim = pointerCount > 0 ? vec2(pointer(0).where.xy) : vec2(0.5, 0.5)
      const glow = 0.25 / (1 + length(vec2(p.uv - aim)) * 9)
      return vec4(base.rgb + vec3(glow), 1)
    }),
  ],
})
