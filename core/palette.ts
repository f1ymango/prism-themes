// Palette → the app's CSS variables. The token list and the derivation are adapted from
// 0toshigami/claude-desktop-themes (MIT), extension/src/core.js.

export type Rgb = [number, number, number]

export const isHex = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)
export const rgb = (c: string): Rgb => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255) as Rgb
export const hex = (c: Rgb) => '#' + c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
export const mix = (a: Rgb, b: Rgb, k: number): Rgb => a.map((v, i) => v + (b[i]! - v) * k) as Rgb
export const luma = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const relLum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
/** WCAG contrast ratio of two colours. */
export const contrast = (a: Rgb, b: Rgb) => {
  const x = relLum(a), y = relLum(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
/** The text colour mixed toward the background by up to `k`, but never below `min` contrast against it. */
const towardBg = (tx: Rgb, bg: Rgb, k: number, min: number) => {
  for (let f = k; f > 0; f -= 0.05) if (contrast(mix(tx, bg, f), bg) >= min) return hex(mix(tx, bg, f))
  return hex(tx)
}

export const rgba = (c: string, a: number) => `rgba(${rgb(c).map(v => Math.round(v * 255)).join(', ')}, ${a})`

const hsl = ([r, g, b]: Rgb) => {
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), l = (hi + lo) / 2, d = hi - lo
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0
  const h = !d ? 0 : hi === r ? ((g - b) / d + 6) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4
  return `${Math.round(h * 60)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%`
}

export type Palette = { bg: string; text: string; accent: string }

export const modeOf = (p: Palette): 'light' | 'dark' => (luma(rgb(p.bg)) < 0.5 ? 'dark' : 'light')

/** Every CSS variable a palette sets, by name without the leading `--`. */
export const varsOf = (p: Palette): Record<string, string> => {
  const bg = rgb(p.bg), tx = rgb(p.text), ac = rgb(p.accent)
  const at = (a: Rgb, b: Rgb, k: number) => hex(mix(a, b, k))
  // secondary and muted text keep WCAG AA (4.5:1) against the background, however close the palette's colours are
  const second = towardBg(tx, bg, 0.35, 4.5), muted = towardBg(tx, bg, 0.55, 4.5)
  const hover = at(ac, tx, 0.15), tint = at(bg, ac, 0.15)
  const on = luma(ac) > 0.55 ? '#000000' : '#ffffff'
  const cds: Record<string, string> = {
    'page-bg': p.bg, 'surface-0': p.bg, 'surface-1': at(bg, tx, 0.03), 'surface-2': at(bg, tx, 0.06), 'surface-3': at(bg, tx, 0.09),
    'neutral-900': p.text, 'neutral-600': second, 'neutral-400': muted,
    'text-primary': p.text, 'undimmed-text-primary': p.text,
    'text-secondary': second, 'undimmed-text-secondary': second, 'text-stays-secondary': second, 'undimmed-text-stays-secondary': second,
    'text-muted': muted, 'undimmed-text-muted': muted,
    'role-accent-450': p.accent, 'role-accent-fill': p.accent, 'fill-accent': p.accent, 'text-accent': p.accent,
    'clay': p.accent, 'clay-emphasized': p.accent, 'fill-brand': p.accent,
    'role-accent-400': hover, 'role-accent-fill-hover': hover, 'fill-accent-hover': hover, 'fill-brand-hover': hover,
    'role-accent-on': on, 'on-accent': on, 'on-brand': on,
    'bg-accent': tint, 'role-accent-100': tint, 'role-accent-800': tint,
  }
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(cds)) vars[`cds-${k}`] = v
  ;[0.06, 0, 0.03, 0.05, 0.08, 0.1].forEach((k, i) => (vars[`bg-${i}00`] = hsl(mix(bg, tx, k))))
  ;[0, 0, 0.25, 0.25, 0.5, 0.5].forEach((k, i) => (vars[`text-${i}00`] = hsl(mix(tx, bg, k))))
  for (const k of ['accent-brand', 'brand-100', 'accent-000', 'accent-100', 'accent-200']) vars[k] = hsl(ac)
  // our own, read by our stylesheet
  vars['prism-sidebar'] = at(bg, tx, 0.04)
  vars['prism-glass'] = rgba(p.bg, 0.6)
  vars['prism-halo'] = p.bg
  return vars
}

export const FONT_VARS = ['cds-font-sans', 'cds-font-sans-display', 'font-anthropic-sans', 'font-anthropic-serif', 'font-sans']
export const isFont = (f: unknown): f is string => typeof f === 'string' && /^[\w\s,"'-]{1,200}$/.test(f)
