// The officially supported route: Claude Code's own theme API ($.theme.set), which the desktop app draws itself.
// Prism sends everything that route can carry through it, and keeps the extension for the rest (picture and video
// backgrounds, fonts, corners, stylesheets, reactions). The engine's call has had three shapes so far, and an older
// Claude Code keeps working:
//   2.1.324+  $.theme.set({ colors, backdrop: { scene, glass }, overrideColorScheme })  (2.1.326 refuses any other key
//             in a scene, such as the `id` Prism used to send beside it)
//   2.1.323   $.theme.set({ backdrop: { scene, glass }, overrideColorScheme })
//   2.1.319+  $.theme.set({ backdrop: { id, glass, colorScheme } })
//   earlier   $.ui.backdrop({ id, glass })
// Same approach as Anthropic's theme-examples plugin: try the newest shape, and fall back only when the engine says it
// does not know that call or attribute.

import { modeOf } from './palette'
import type { Panels, Theme } from './resolve'

export type Glass = { blur: number; tint: string; opacity: number } | false

/** The panel glass the desktop app frosts over an official backdrop, from Prism's own panel settings. */
export function glassFor(t: Theme | undefined, opts: { panels?: Panels; panelTint?: number; panelBlur?: number }): Glass {
  const style = opts.panels ?? t?.panels ?? 'glass'
  if (style === 'solid') return false
  const blur = Math.max(0, Math.min(40, opts.panelBlur ?? 14))
  const tint = t ? (t.variants ? t.variants.dark.bg : t.palette.bg) : '#000000'
  return style === 'clear' ? { blur: 0, tint, opacity: 0 } : { blur, tint, opacity: Math.max(0, Math.min(0.9, opts.panelTint ?? 0.4)) }
}

/** light or dark for a theme with one palette; a theme with both follows the app, so none is asked for. */
export const schemeFor = (t: Theme | undefined): 'light' | 'dark' | undefined => (t && !t.variants ? modeOf(t.palette) : undefined)

/** A backdrop's scene name: letters, digits, _ and -, up to 64. */
export const sceneName = (kind: 'gradient' | 'svg' | 'live' | 'native', id: string) => `prism-${kind}-${id}`.replace(/[^\w-]/g, '-').slice(0, 64)

/** Reads the scene a Backdrop hook is asked for: `scene` on newer engines, `id` before. */
export function sceneOf(props: { scene?: unknown; id?: unknown }): string | undefined {
  if (typeof props.scene === 'string') return props.scene
  return typeof props.id === 'string' ? props.id : undefined
}

/** True when an error means "this engine has no such call or attribute", so the next older shape may be tried. */
export function isOlderEngine(err: unknown, member?: string): boolean {
  if (err instanceof TypeError) return true
  const text = err instanceof Error ? err.message : String(err)
  return /does not know the attribute|is not a function/i.test(text) || (!!member && text.includes(member))
}

/** An official SVG backdrop is used for a picture only up to this size (the engine's limit is 131,072 characters). */
export const OFFICIAL_SVG_MAX = 131_072
