// Official colours: a Prism palette as the input to Anthropic's makeColors (hooks/make-colors.js), which builds the
// desktop app's own design-system palette for $.theme.set({ colors }). Prism gives the page and text anchors and the
// accent; the design system works out every other border and fill. Dark mode also gets its surfaces, kept close to
// the page (the design system's own steps can leave muted text too faint on menus); light mode's are left to it, since
// its cards must sit lighter than the page and Prism's own derivation steps them darker.
import { hex, mix, modeOf, rgb } from './palette'
import type { Palette } from './palette'
import type { Theme } from './resolve'

type Anchors = Record<'surface-0' | 'text-primary', string> &
  Partial<Record<'surface-1' | 'surface-2' | 'surface-3' | 'text-secondary' | 'text-muted', string>>
type Mode = { gray: { anchors: Anchors }; roles: { accent: string } }

/** The makeColors definition for a theme: both modes for a light/dark theme, else its one mode alone. */
export type ColorsDefinition = { label: string; id: string; light?: Mode; dark?: Mode; only?: 'light' | 'dark' }

/** How far secondary and muted text lean toward the page, softest first; the first Desktop will paint is used. */
const STEPS: [number, number][] = [[0.35, 0.55], [0.3, 0.45], [0.25, 0.35], [0.2, 0.25], [0.12, 0.15], [0.05, 0.05]]

const modeFor = (p: Palette, [second, muted]: [number, number]): Mode => {
  const bg = rgb(p.bg), tx = rgb(p.text)
  const toward = (k: number) => hex(mix(tx, bg, k))
  const anchors: Anchors = { 'surface-0': hex(bg), 'text-primary': hex(tx), 'text-secondary': toward(second), 'text-muted': toward(muted) }
  if (modeOf(p) === 'dark') {
    anchors['surface-1'] = hex(mix(bg, tx, 0.025))
    anchors['surface-2'] = hex(mix(bg, tx, 0.045))
    anchors['surface-3'] = hex(mix(bg, tx, 0.065))
  }
  return { gray: { anchors }, roles: { accent: p.accent.toLowerCase() } }
}

export function colorsDefinition(t: Theme, step = 0): ColorsDefinition {
  const k = STEPS[Math.min(step, STEPS.length - 1)]!
  const base = { label: t.name.slice(0, 64) || t.id, id: t.id }
  if (t.variants) return { ...base, light: modeFor(t.variants.light, k), dark: modeFor(t.variants.dark, k) }
  const mode = modeOf(t.palette)
  return { ...base, [mode]: modeFor(t.palette, k), only: mode }
}

/** The makeColors lines that mean Desktop ignores the whole palette. */
export const unpainted = (problems: string[]) => problems.filter(line => line.startsWith("Desktop won't paint"))

/**
 * The theme's official palette: the softest secondary and muted text Desktop will paint. `make` is makeColors.
 * `refused` holds Desktop's reason when no step passes (the page then keeps painting the colours).
 */
export function officialPalette<T>(t: Theme, make: (d: ColorsDefinition) => { theme: T; problems: string[] }):
  { theme: T; refused?: undefined } | { theme?: undefined; refused: string } {
  let last = ''
  for (let step = 0; step < STEPS.length; step++) {
    const { theme, problems } = make(colorsDefinition(t, step))
    const bad = unpainted(problems)
    if (!bad.length) return { theme }
    last = bad[0]!
  }
  return { refused: last }
}
