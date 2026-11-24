// /prism census shader: shows the Svg under it, with the right half's colours inverted so it is plain the shader is
// running, to see whether the Svg's own animation reaches the shader.
import { picture, scene, shader, vec3, vec4 } from 'claude-code/shader'

export default shader({
  fps: 30,
  passes: [picture(q => {
    const c = scene.sample(q.uv).rgb
    return vec4(q.uv.x > 0.5 ? vec3(1 - c) : c, 1)
  })],
})
