// C2: one theme → what each tier draws. The mod does all the deriving; the page only applies data.
import type { Provider } from './media'
import { FONT_VARS, isFont, modeOf, rgba, varsOf } from './palette'
import type { Palette } from './palette'
import { BASE_RULES, REACTION_RULES, ROLES, TITLEBAR_CSS, WALL_RULES } from './roles'
import type { RoleRule } from './roles'

export type Gradient = { kind: 'gradient'; angle: number; stops: string[] }
export type Status = { idle: string; tool: string; error: string; done: string }
export type Theme = {
  id: string
  name: string
  tagline: string
  /** the palette used when the app's mode is unknown; with variants, the dark one */
  palette: Palette
  /** light and dark palettes: the page follows the app's own mode */
  variants?: { light: Palette; dark: Palette }
  font?: string
  radius?: { base: number; composer: number }
  background?: Gradient
  /** a picture, video or folder from the person's themes folder (path resolved by the host) */
  media?: { path: string; fit: 'cover' | 'contain'; dim: number; interval: number }
  panels?: Panels
  status?: Status
  tokens?: Record<string, string>
  /** the theme's own stylesheet, already checked */
  css?: string
  /** where it came from */
  source?: 'builtin' | 'user'
}

/** A media background as the page draws it: files are paths inside the extension folder. */
export type PageBackground = { provider: Provider; files: string[]; interval: number; fit: 'cover' | 'contain'; dim: number }

/** What the content script reads from prism-theme.json; `{}` means Claude's own look. */
export type Payload = {
  v: 1
  id: string
  mode?: 'light' | 'dark'
  vars: Record<string, string>
  css: string
  roles: Record<string, string[]>
  rules: RoleRule[]
  background?: PageBackground
  /** how the side panels sit over a page-drawn background */
  panels?: Panels
  /** light and dark colour variables: the page picks by the app's own mode and lays them over `vars` */
  variants?: { light: Record<string, string>; dark: Record<string, string> }
}

export type Panels = 'glass' | 'clear' | 'solid'

export const gradientCss = (g: Gradient) => `linear-gradient(${g.angle}deg, ${g.stops.join(', ')})`

/** The same gradient as an SVG document, for the tier-1 backdrop. */
export const gradientSvg = (g: Gradient) => {
  const r = ((g.angle - 90) * Math.PI) / 180
  const x = Math.cos(r) / 2, y = Math.sin(r) / 2
  const stops = g.stops.map((c, i) => `<stop offset="${i / Math.max(1, g.stops.length - 1)}" stop-color="${c}"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90" preserveAspectRatio="none">` +
    `<defs><linearGradient id="g" x1="${0.5 - x}" y1="${0.5 - y}" x2="${0.5 + x}" y2="${0.5 + y}">${stops}</linearGradient></defs>` +
    `<rect width="160" height="90" fill="url(#g)"/></svg>`
}

export type ResolveOptions = {
  /** the theme's gradient is drawn by the page (the official backdrop is not drawing it) */
  backgroundByPage: boolean
  /** a custom media background, already copied into the extension folder */
  media?: PageBackground
  /** side panels over the background, as the person chose; else the theme's, else glass */
  panels?: Panels
}

/** Theme (or none: Claude's own colours) → payload. Claude's own look with no custom background is `{}`. */
export const resolve = (t: Theme | undefined, opts: ResolveOptions): Payload | Record<string, never> => {
  if (!t && !opts.media) return {}
  const vars: Record<string, string> = t
    ? varsOf(t.palette)
    // Claude's own colours over a background: a lighter tint than a palette theme's 60%, since the app's own
    // surface colour is close to the dark videos people use, and 62% read as solid there
    : { 'prism-glass': 'color-mix(in srgb, var(--cds-surface-1) 45%, transparent)', 'prism-halo': 'var(--cds-surface-0)' }
  if (t && isFont(t.font)) for (const k of FONT_VARS) vars[k] = t.font
  if (t?.radius) {
    vars['cds-radius'] = `${t.radius.base}px`
    vars['cds-panel-radius'] = `${t.radius.base + 4}px`
    vars['cds-radius-composer'] = `${t.radius.composer}px`
  }
  if (t?.tokens) for (const [k, v] of Object.entries(t.tokens)) vars[k] = v
  // with variants the page follows the app's mode, so no mode is forced
  const mode = t && !t.variants ? modeOf(t.palette) : undefined
  const gradient = !opts.media && opts.backgroundByPage && t?.background
  if (opts.media) {
    vars['prism-wall'] = t ? t.palette.bg : 'transparent'
    vars['prism-dim'] = rgba(t?.palette.bg ?? '#000000', Math.max(0, Math.min(0.9, opts.media.dim)))
  } else if (gradient) {
    vars['prism-wall'] = gradientCss(t.background!)
  }
  if (mode === 'light') vars['prism-controls'] = t!.palette.text
  const variants = t?.variants && {
    light: { ...varsOf(t.variants.light), 'prism-controls': t.variants.light.text },
    dark: varsOf(t.variants.dark),
  }
  const rules = [...(t ? BASE_RULES : []), ...(opts.media || gradient ? WALL_RULES : []), ...REACTION_RULES]
  const css = [mode === 'light' || variants ? TITLEBAR_CSS : '', t?.css ?? ''].filter(Boolean).join('\n')
  return {
    v: 1, id: t?.id ?? 'claude', mode, vars, css,
    roles: ROLES, rules, background: opts.media,
    // the person's own /prism panels choice wins over the theme's default
    panels: opts.media || gradient ? opts.panels ?? t?.panels ?? 'glass' : undefined,
    variants,
  }
}

// Same rules as the content script applies again in the page: a theme's CSS loads nothing from outside.
// Backslashes are refused because a CSS escape can spell url( past these checks.
export const safeCss = (css: unknown): css is string =>
  typeof css === 'string' && css.length <= 200000 && !/\\/.test(css)
  && !/@import|image-set|expression\s*\(|-moz-binding|behavior\s*:|javascript:/i.test(css)
  && !/url\(\s*(?!['"]?data:)/i.test(css)
