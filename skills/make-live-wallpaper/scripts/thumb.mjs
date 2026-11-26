// thumb.mjs: the loading preview a KA2 parcel carries in words the codec leaves free, drawn by hooks/live-key.ts
// (blurred, B-spline) while the keyframe is collected and decoded.
//   word 11            'THB' (0x544842): a preview is present
//   words 1152..1191   luma 16 x 10 (row 0 at the top), 6 bits a texel (Y = v * 4 + 2), 4 a word, high first
//   words 1192..1211   chroma 8 x 5, a texel = Co (6 bits) then Cg (6 bits), 2 a word, high first; Co, Cg = (v - 32) * 4
//   YCoCg here: Y = (R + 2G + B) / 4, Co = (R - B) / 2, Cg = (2G - R - B) / 4; R = Y + Co - Cg, G = Y + Cg, B = Y - Co - Cg
// As a tool: node thumb.mjs <in.svg> <picture.rgb> <w> <h> <out.svg> puts a preview into an existing KA2 Svg (the
// values change in place, so the Svg keeps its length).
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const THB = 0x544842, TY0 = 1152, TC0 = 1192, TW = 16, TH = 10, CW = 8, CH = 5

/** box averages of an rgb picture over a gw x gh grid, as [Y, Co, Cg] */
function grid(rgb, W, H, gw, gh) {
  const r = []
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    let y = 0, co = 0, cg = 0, n = 0
    for (let py = Math.floor((j * H) / gh); py < Math.floor(((j + 1) * H) / gh); py++)
      for (let px = Math.floor((i * W) / gw); px < Math.floor(((i + 1) * W) / gw); px++) {
        const o = (py * W + px) * 3, R = rgb[o], G = rgb[o + 1], B = rgb[o + 2]
        y += (R + 2 * G + B) / 4; co += (R - B) / 2; cg += (2 * G - R - B) / 4; n++
      }
    r.push([y / n, co / n, cg / n])
  }
  return r
}
const q6 = (v, step, mid) => Math.min(63, Math.max(0, Math.round(v / step) + mid))

/** the preview's words: { [word index]: value } (header mark included) */
export function thumbWords(rgb, W, H) {
  const out = { 11: THB }
  grid(rgb, W, H, TW, TH).forEach(([y], t) => { const w = TY0 + (t >> 2); out[w] = (out[w] ?? 0) | (q6(y - 2, 4, 0) << (18 - 6 * (t & 3))) })
  grid(rgb, W, H, CW, CH).forEach(([, co, cg], t) => {
    const w = TC0 + (t >> 1); out[w] = (out[w] ?? 0) | (((q6(co, 4, 32) << 6) | q6(cg, 4, 32)) << (t & 1 ? 0 : 12))
  })
  return out
}

/** a KA2 Svg with the preview's words put in (cell i of moment k holds word k * 128 + i; the clock cell comes first) */
export function patchSvg(svg, words) {
  const cells = [...svg.matchAll(/values="([^"]*)"/g)]
  if (cells.length !== 129) throw new Error(`${cells.length} cells, expected 129`)
  let out = '', from = 0
  cells.slice(1).forEach((m, i) => {
    const list = m[1].split(';')
    let changed = false
    for (const [w, v] of Object.entries(words)) {
      if (+w % 128 !== i) continue
      list[Math.floor(+w / 128)] = '#' + v.toString(16).padStart(6, '0'); changed = true
    }
    if (!changed) return
    const at = m.index + 'values="'.length
    out += svg.slice(from, at) + list.join(';'); from = at + m[1].length
  })
  return out + svg.slice(from)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , inP, rgbP, w, h, outP] = process.argv
  const svg = readFileSync(inP, 'utf8')
  const words = thumbWords(readFileSync(rgbP), +w, +h)
  const was = [...svg.matchAll(/values="([^"]*)"/g)].slice(1)
  for (const k of Object.keys(words)) if (+k !== 11 && was[+k % 128][1].split(';')[Math.floor(+k / 128)] !== '#000000') throw new Error(`word ${k} is in use`)
  const out = patchSvg(svg, words)
  if (out.length !== svg.length) throw new Error('length changed')
  writeFileSync(outP, out)
  console.log(`${outP}: preview in ${Object.keys(words).length} words, ${out.length} chars`)
}
