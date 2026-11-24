// /prism channel: how many bits an Svg character can carry to a shader. Each variant draws pseudo-random data from a
// hash this file and its shader (hooks/channel-*.ts) both know; the shader reads what reached `scene`, compares it bit
// for bit with what was drawn, and paints the verdict. The stats count every character of the Svg.
//
// bars     one path a bit plane, a bar a column: `V<height>h1`. 24 planes added by mix-blend-mode plus-lighter.
// dash     one serpentine line through every row, drawn once a bit plane (<use>) with its own stroke-dasharray.
// palette  16 colours, one path a colour, listing its cells as runs.
// smil     128 cells, each animating its fill through a list of colours (`values="#rrggbb;..."`, discrete), plus a
//          clock cell; the shader collects one moment a frame into a buffer.

export type ChannelKind = 'bars' | 'bars-fine' | 'dash' | 'palette' | 'smil'
export const CHANNEL_KINDS: readonly ChannelKind[] = ['bars', 'bars-fine', 'dash', 'palette', 'smil']

export interface ChannelProbe {
  kind: ChannelKind
  svg: string
  /** the shader's `values` */
  values: Record<string, number>
  chars: number
  /** data bits the Svg carries (what the shader checks) */
  bits: number
  /** one line: what was drawn and the rate */
  summary: string
}

/** The budget each probe fills, under the backdrop's 131,072. */
export const CHANNEL_BUDGET = 130_000

/** The hash the shaders repeat: 32-bit, from two whole numbers. */
export function mix32(a: number, b: number): number {
  let h = Math.imul(a | 0, 739982445) ^ Math.imul((b + 374761393) | 0, 73244475)
  h ^= h >>> 16
  h = Math.imul(h, 73244475)
  h ^= h >>> 16
  h = Math.imul(h, 73244475)
  h ^= h >>> 16
  return h >>> 0
}
/** 20 bits of the hash, for numbers taken modulo a range. */
const val = (a: number, b: number) => mix32(a, b) >>> 12
const hex2 = (x: number) => (x & 255).toString(16).padStart(2, '0')
/** plane p's colour: one bit, R's top bit first */
const planeColor = (p: number) => {
  const v = (1 << (23 - p)) >>> 0
  return '#' + hex2(v >>> 16) + hex2(v >>> 8) + hex2(v)
}
const head = (w: number, h: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" shape-rendering="crispEdges">` +
  `<rect width="${w}" height="${h}"/>`
const PLUS = 'style="mix-blend-mode:plus-lighter"'
const rate = (bits: number, chars: number) => (bits / chars).toFixed(2)

// bars: W columns, heights 0..H in units, one path a bit plane. H 540 = 2 px units; 1000 = ~1.08 px (fine).
export const BARS_W = 960
export const barHeight = (p: number, c: number, H: number) => val(p, c) % (H + 1)
function bars(H: number, kind: ChannelKind): ChannelProbe {
  const top = head(BARS_W, H)
  let body = ''
  let planes = 0
  for (let p = 0; p < 24; p++) {
    let d = 'M0 0'
    for (let c = 0; c < BARS_W; c++) d += `V${barHeight(p, c, H)}h1`
    const path = `<path fill="${planeColor(p)}" ${PLUS} d="${d}V0z"/>`
    if (top.length + body.length + path.length + 6 > CHANNEL_BUDGET) break
    body += path
    planes++
  }
  const svg = `${top}${body}</svg>`
  const bits = planes * BARS_W * Math.log2(H + 1)
  return {
    kind, svg, values: { w: BARS_W, h: H, planes }, chars: svg.length, bits,
    summary: `bars: ${planes} planes x ${BARS_W} columns, heights 0-${H} (${Math.log2(H + 1).toFixed(2)} bits), ` +
      `${svg.length} chars, ${Math.round(bits)} bits = ${rate(bits, svg.length)} bits/char`,
  }
}

// dash: a W x H grid of units; one line runs row by row (left to right, then back), stepping down outside the grid.
// Each row is DASH_ROW units of path (W + 2 across, 1 down). The dash pattern is pairs (on d, off P - d), so the
// shader can find a unit's pair without adding up every run before it; a free-run decoder would count both numbers.
export const DASH_W = 960
export const DASH_H = 540
export const DASH_ROW = DASH_W + 3
export const DASH_P = 1000
export const dashOn = (p: number, k: number) => 1 + (val(p, k) % (DASH_P - 1))
function dash(): ChannelProbe {
  const top = head(DASH_W, DASH_H)
  let line = 'M-1 .5'
  for (let r = 0; r < DASH_H; r++) line += (r % 2 ? 'H-1' : `H${DASH_W + 1}`) + (r < DASH_H - 1 ? 'v1' : '')
  const defs = `<defs><path id="s" fill="none" stroke-width="1" d="${line}"/></defs>`
  const pairs = Math.ceil((DASH_H * DASH_ROW) / DASH_P)
  let body = ''
  let planes = 0
  let numbers = 0
  for (let p = 0; p < 24; p++) {
    const list: number[] = []
    for (let k = 0; k < pairs; k++) { const d = dashOn(p, k); list.push(d, DASH_P - d) }
    const use = `<use href="#s" stroke="${planeColor(p)}" ${PLUS} stroke-dasharray="${list.join(' ')}"/>`
    if (top.length + defs.length + body.length + use.length + 6 > CHANNEL_BUDGET) break
    body += use
    planes++
    numbers += list.length
  }
  const svg = `${top}${defs}${body}</svg>`
  const bits = planes * pairs * Math.log2(DASH_P - 1)
  const free = numbers * Math.log2(DASH_P - 1)
  return {
    kind: 'dash', svg, values: { w: DASH_W, h: DASH_H, planes, period: DASH_P }, chars: svg.length, bits,
    summary: `dash: ${planes} planes x ${pairs} pairs (on 1-${DASH_P - 1}), ${svg.length} chars, ${Math.round(bits)} bits = ` +
      `${rate(bits, svg.length)} bits/char as drawn; free runs (every number data) would be ${rate(free, svg.length)}`,
  }
}

// palette: GW x GH cells, each one of 16 colours; one path a colour, its cells as runs in reading order.
export const PAL_W = 192
export const PAL_H = 108
export const palIndex = (i: number, j: number) => val(i, j + 4096) & 15
export const palColor = (c: number) => mix32(c, 77777) >>> 8
function palette(): ChannelProbe {
  const top = head(PAL_W, PAL_H)
  const paths: string[] = Array.from({ length: 16 }, () => '')
  const last: ({ x: number; y: number } | undefined)[] = Array.from({ length: 16 }, () => undefined)
  let rows = 0
  let used = top.length + 6 + 16 * 40
  for (let j = 0; j < PAL_H; j++) {
    const add: string[] = Array.from({ length: 16 }, () => '')
    const at = last.slice()
    for (let i = 0; i < PAL_W;) {
      const c = palIndex(i, j)
      let n = 1
      while (i + n < PAL_W && palIndex(i + n, j) === c) n++
      const prev = at[c]
      // after `h n v1 h-n` the pen is at (x, y + 1)
      add[c] += (prev ? `m${i - prev.x} ${j - prev.y - 1}` : `M${i} ${j}`) + `h${n}v1h-${n}`
      at[c] = { x: i, y: j }
      i += n
    }
    const cost = add.reduce((s, a) => s + a.length, 0)
    if (used + cost > CHANNEL_BUDGET) break
    used += cost
    for (let c = 0; c < 16; c++) { paths[c] = paths[c]! + add[c]!; last[c] = at[c] }
    rows++
  }
  let body = ''
  for (let c = 0; c < 16; c++) {
    const v = palColor(c)
    if (paths[c]) body += `<path fill="#${hex2(v >>> 16)}${hex2(v >>> 8)}${hex2(v)}" d="${paths[c]}"/>`
  }
  const svg = `${top}${body}</svg>`
  const bits = rows * PAL_W * 4
  return {
    kind: 'palette', svg, values: { w: PAL_W, h: PAL_H, rows }, chars: svg.length, bits,
    summary: `palette: 16 colours, ${rows} rows x ${PAL_W} cells (4 bits each), ${svg.length} chars, ${bits} bits = ` +
      `${rate(bits, svg.length)} bits/char`,
  }
}

// smil: SMIL_N data cells in a 16-wide grid of 1-unit squares (viewBox 160 x 90), the clock cell under them. Each
// moment k of SMIL_M, cell i shows smilColor(i, k); the clock shows k in its green and blue.
export const SMIL_N = 128
export const SMIL_M = 110
export const SMIL_COLS = 16
export const smilColor = (i: number, k: number) => mix32(i + 8192, k) >>> 8
function smil(stepMs: number): ChannelProbe {
  const dur = +((SMIL_M * stepMs) / 1000).toFixed(3)
  const top = head(160, 90)
  const cell = (x: number, y: number, list: number[]) =>
    `<path d="M${x} ${y}h1v1H${x}"><animate attributeName="fill" dur="${dur}s" calcMode="discrete" ` +
    `repeatCount="indefinite" values="${list.map(v => '#' + hex2(v >>> 16) + hex2(v >>> 8) + hex2(v)).join(';')}"/></path>`
  let body = ''
  for (let i = 0; i < SMIL_N; i++) {
    body += cell(i % SMIL_COLS, Math.floor(i / SMIL_COLS), Array.from({ length: SMIL_M }, (_, k) => smilColor(i, k)))
  }
  body += cell(0, SMIL_N / SMIL_COLS, Array.from({ length: SMIL_M }, (_, k) => k))
  const svg = `${top}${body}</svg>`
  const bits = SMIL_N * SMIL_M * 24
  return {
    kind: 'smil', svg, values: { step: stepMs }, chars: svg.length, bits,
    summary: `smil: ${SMIL_N} cells x ${SMIL_M} moments x 24 bits, a moment every ${stepMs} ms (${dur} s a loop), ` +
      `${svg.length} chars, ${bits} bits = ${rate(bits, svg.length)} bits/char`,
  }
}

/** The per-cell baseline (/prism probe): `<path fill="#rrggbb" d="M i j h1v1h-1z"/>`, 24 bits a cell. */
export function cellsRate(): string {
  const sample = '<path fill="#a3f29c" d="M480 270h1v1h-1z"/>'
  return `cells (/prism probe): ~${sample.length} chars a 24-bit cell = ${rate(24, sample.length)} bits/char`
}

export function channelProbe(kind: ChannelKind, stepMs = 100): ChannelProbe {
  switch (kind) {
    case 'bars': return bars(540, kind)
    case 'bars-fine': return bars(1000, kind)
    case 'dash': return dash()
    case 'palette': return palette()
    case 'smil': return smil(stepMs)
  }
}
