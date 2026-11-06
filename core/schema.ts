// C6: theme files (schema 2), inheritance, selection rules, and the importer for the baseline's v1 files.
// Pure: host.ts reads the files and hands their text here.
import type { Palette } from './palette'
import { isFont, isHex } from './palette'
import type { Gradient, Panels, Status, Theme } from './resolve'
import { safeCss } from './resolve'

/** A theme as written, before inheritance: every layer optional. */
export type Draft = {
  id: string
  name?: string
  tagline?: string
  extends?: string
  palette?: Palette
  variants?: { light: Palette; dark: Palette }
  font?: string
  radius?: { base: number; composer: number }
  background?: Gradient
  /** a picture, video or folder, relative to the theme file's folder (or absolute) */
  media?: { path: string; fit: 'cover' | 'contain'; dim: number; interval: number }
  panels?: Panels
  status?: Status
  /** raw CSS variables: an escape hatch, tied to the app's current token names */
  tokens?: Record<string, string>
  /** a stylesheet file name beside the theme file */
  cssFile?: string
  /** the stylesheet's text, once the host has read and checked it */
  css?: string
}

export type Parsed = { draft?: Draft; errors: string[]; warnings: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
export const ID = /^[a-z][a-z0-9-]{1,40}$/
const TOKEN = /^[a-z][a-z0-9-]{0,80}$/
const FILE = /^[\w .()-]{1,120}$/

const palette = (v: unknown, at: string, errors: string[]): Palette | undefined => {
  if (!isObj(v)) { errors.push(`${at}: expected { bg, text, accent }`); return undefined }
  const bad = (['bg', 'text', 'accent'] as const).filter(k => !isHex(v[k]))
  if (bad.length) { errors.push(`${at}: ${bad.map(k => `${k} must be a #rrggbb colour`).join('; ')}`); return undefined }
  return { bg: String(v.bg), text: String(v.text), accent: String(v.accent) }
}

/** Reads one theme file (schema 2). Errors make the theme unusable; warnings do not. */
export const parseTheme = (raw: unknown): Parsed => {
  const errors: string[] = [], warnings: string[] = []
  if (!isObj(raw)) return { errors: ['the file is not a JSON object'], warnings }
  if (raw.schema !== 2) errors.push('schema: must be 2 (a v1 theme? use /prism import <folder>)')
  if (!str(raw.id, 41) || !ID.test(raw.id)) errors.push('id: lowercase letters, digits and dashes, starting with a letter (2–41)')
  const d: Draft = { id: typeof raw.id === 'string' ? raw.id : '' }
  if (raw.name !== undefined) { if (str(raw.name, 60)) d.name = raw.name; else errors.push('name: text, up to 60 characters') }
  if (raw.tagline !== undefined) { if (str(raw.tagline, 200)) d.tagline = raw.tagline; else warnings.push('tagline: ignored (text up to 200)') }
  if (raw.extends !== undefined) { if (str(raw.extends, 41) && ID.test(raw.extends)) d.extends = raw.extends; else errors.push('extends: a theme id') }

  if (raw.palette !== undefined) {
    const p = raw.palette
    if (isObj(p) && (isObj(p.light) || isObj(p.dark))) {
      const light = palette(p.light, 'palette.light', errors), dark = palette(p.dark, 'palette.dark', errors)
      if (light && dark) d.variants = { light, dark }
    } else d.palette = palette(p, 'palette', errors)
  }
  if (raw.typography !== undefined) {
    const f = isObj(raw.typography) ? raw.typography.font : undefined
    if (isFont(f)) d.font = f; else errors.push('typography.font: a CSS font list (letters, digits, spaces, commas, quotes, dashes)')
  }
  if (raw.shape !== undefined) {
    const s = raw.shape
    const n = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 40
    if (isObj(s) && n(s.radius) && (s.composerRadius === undefined || n(s.composerRadius))) {
      d.radius = { base: s.radius as number, composer: (s.composerRadius as number | undefined) ?? (s.radius as number) * 2 }
    } else errors.push('shape: { radius, composerRadius? } in pixels, 0–40')
  }
  if (raw.background !== undefined) {
    const b = raw.background
    if (isObj(b) && isObj(b.gradient)) {
      // one gradient, or a light and a dark one (as palettes are written)
      const one = (g: unknown, at: string) => {
        const o = isObj(g) ? g : {}
        const stops = Array.isArray(o.stops) ? o.stops : []
        if (typeof o.angle === 'number' && stops.length >= 2 && stops.length <= 8 && stops.every(isHex)) {
          return { angle: o.angle, stops: stops as string[] }
        }
        errors.push(`${at}: { angle, stops: 2–8 #rrggbb colours }`)
        return undefined
      }
      const g = b.gradient
      if (isObj(g.light) || isObj(g.dark)) {
        const light = one(g.light, 'background.gradient.light'), dark = one(g.dark, 'background.gradient.dark')
        if (light && dark) d.background = { kind: 'gradient', ...dark, light }
        if (raw.palette !== undefined && !d.variants) warnings.push('background.gradient.light: shown only by a theme with light and dark palettes')
      } else {
        const only = one(g, 'background.gradient')
        if (only) d.background = { kind: 'gradient', ...only }
      }
    } else if (isObj(b) && str(b.file, 1000)) {
      const fit = b.fit === 'contain' ? 'contain' : 'cover'
      const dim = typeof b.dim === 'number' && b.dim >= 0 && b.dim <= 0.9 ? b.dim : 0.25
      const interval = typeof b.interval === 'number' && b.interval >= 5 ? b.interval : 60
      d.media = { path: b.file, fit, dim, interval }
    } else errors.push('background: { gradient: {...} } or { file, fit?, dim?, interval? }')
  }
  if (raw.panels !== undefined) {
    if (raw.panels === 'glass' || raw.panels === 'clear' || raw.panels === 'solid') d.panels = raw.panels
    else errors.push('panels: glass, clear or solid')
  }
  if (raw.status !== undefined) {
    const s = raw.status
    if (isObj(s) && (['idle', 'tool', 'error', 'done'] as const).every(k => str(s[k], 80))) {
      d.status = { idle: String(s.idle), tool: String(s.tool), error: String(s.error), done: String(s.done) }
    } else errors.push('status: { idle, tool, error, done }, each up to 80 characters ({tool} is the tool\'s name)')
  }
  if (raw.tokens !== undefined) {
    if (!isObj(raw.tokens)) errors.push('tokens: { "variable-name": "value" }')
    else {
      d.tokens = {}
      for (const [k, v] of Object.entries(raw.tokens)) {
        if (TOKEN.test(k) && typeof v === 'string' && v.length <= 500 && !/[;{}<>]/.test(v) && safeCss(v)) d.tokens[k] = v
        else warnings.push(`tokens.${k}: refused (a name like cds-radius, and a value with no ; { } < > or outside url)`)
      }
      if (Object.keys(d.tokens).length) warnings.push('tokens: raw app variables can stop working when Claude Desktop updates')
    }
  }
  if (raw.css !== undefined) { if (str(raw.css, 120) && FILE.test(raw.css)) d.cssFile = raw.css; else errors.push('css: a file name beside the theme') }
  return errors.length ? { errors, warnings } : { draft: d, errors, warnings }
}

/** Follows `extends` to the root and merges layer by layer (the child's layer wins). */
export const finalize = (id: string, lookup: (id: string) => Draft | undefined): { theme?: Theme; errors: string[] } => {
  const chain: Draft[] = []
  for (let at: string | undefined = id; at; at = chain[chain.length - 1]!.extends) {
    if (chain.some(c => c.id === at)) return { errors: [`extends: a loop (${[...chain.map(c => c.id), at].join(' → ')})`] }
    const d = lookup(at)
    if (!d) return { errors: [chain.length ? `extends: no theme "${at}"` : `no theme "${at}"`] }
    chain.push(d)
    if (chain.length > 8) return { errors: ['extends: more than 8 levels'] }
  }
  const merged: Draft = { id }
  for (const d of [...chain].reverse()) {
    for (const [k, v] of Object.entries(d) as [keyof Draft, unknown][]) if (v !== undefined && k !== 'id' && k !== 'extends') (merged as Record<string, unknown>)[k] = v
    if (d.palette) delete merged.variants
    if (d.variants) delete merged.palette
    if (d.background) delete merged.media
    if (d.media) delete merged.background
  }
  const pal = merged.palette ?? merged.variants?.dark
  if (!pal) return { errors: ['palette: none (give one, or extend a theme that has one)'] }
  return {
    theme: {
      id, name: merged.name ?? id, tagline: merged.tagline ?? '', palette: pal, variants: merged.variants,
      font: merged.font, radius: merged.radius, background: merged.background, media: merged.media,
      panels: merged.panels, status: merged.status, tokens: merged.tokens, css: merged.css,
    },
    errors: [],
  }
}

// --- selection rules -------------------------------------------------------------------------------------------

export type Rule = { project?: string; time?: string; use: string }

export const parseRules = (raw: unknown): { rules: Rule[]; errors: string[] } => {
  const errors: string[] = []
  if (!Array.isArray(raw)) return { rules: [], errors: ['rules.json: a list of { "when": {...}, "use": "<theme id>" }'] }
  const rules: Rule[] = []
  raw.forEach((r, i) => {
    if (!isObj(r) || !str(r.use, 41) || !(ID.test(r.use) || r.use === 'claude')) { errors.push(`rules[${i}]: needs "use": a theme id`); return }
    const w = r.when === undefined ? {} : r.when
    if (!isObj(w)) { errors.push(`rules[${i}].when: an object`); return }
    const rule: Rule = { use: r.use }
    if (w.project !== undefined) { if (str(w.project, 1000)) rule.project = w.project; else { errors.push(`rules[${i}].when.project: a folder pattern`); return } }
    if (w.time !== undefined) {
      if (typeof w.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(w.time)) rule.time = w.time
      else { errors.push(`rules[${i}].when.time: "HH:MM-HH:MM", 24-hour`); return }
    }
    rules.push(rule)
  })
  return { rules, errors }
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** `*` is any run of characters, `?` one; a pattern matches the folder itself and anything inside it. */
export const projectMatches = (pattern: string, cwd: string) => {
  const re = norm(pattern).split('').map(c => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]]/g, '\\$&'))).join('')
  return new RegExp(`^${re}(/.*)?$`).test(norm(cwd))
}

/** "22:00-06:00" spans midnight. */
export const timeMatches = (range: string, minutes: number) => {
  const [a, b] = range.split('-').map(t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))) as [number, number]
  return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b
}

/** The first rule whose conditions all hold; undefined when none does. */
export const pickRule = (rules: Rule[], at: { cwd: string; minutes: number }) =>
  rules.find(r => (!r.project || projectMatches(r.project, at.cwd)) && (!r.time || timeMatches(r.time, at.minutes)))

// --- the baseline's v1 files -----------------------------------------------------------------------------------

/** A v1 stylesheet reacts through data-theme-event/state/tool; ours are data-tfc-event/state/tool. */
export const convertV1Css = (css: string) => css.replace(/data-theme-(event|state|tool)\b/g, 'data-tfc-$1')

/** A v1 theme (claude-desktop-themes) as a schema-2 file, and what could not come along. */
export const fromV1 = (raw: unknown, hasCss: boolean): { file?: Record<string, unknown>; notes: string[] } => {
  const notes: string[] = []
  if (!isObj(raw) || !str(raw.id, 41) || !ID.test(raw.id) || !isHex(raw.bg) || !isHex(raw.text) || !isHex(raw.accent)) {
    return { notes: ['not a v1 theme (needs id, bg, text, accent)'] }
  }
  const file: Record<string, unknown> = {
    schema: 2, id: raw.id, name: str(raw.name, 60) ? raw.name : raw.id,
    palette: { bg: raw.bg, text: raw.text, accent: raw.accent },
  }
  if (str(raw.tagline, 200)) file.tagline = raw.tagline
  if (isFont(raw.font)) file.typography = { font: raw.font }
  if (isObj(raw.status)) file.status = raw.status
  if (isObj(raw.vars) && Object.keys(raw.vars).length) {
    const vars = raw.vars as Record<string, unknown>
    const r = (k: string) => (typeof vars[k] === 'string' ? Number.parseFloat(vars[k] as string) : NaN)
    if (Number.isFinite(r('cds-radius'))) {
      file.shape = { radius: r('cds-radius'), ...(Number.isFinite(r('cds-radius-composer')) ? { composerRadius: r('cds-radius-composer') } : {}) }
    }
    const rest = Object.fromEntries(Object.entries(vars).filter(([k]) => !k.startsWith('cds-radius') && !k.startsWith('wall-')))
    if (Object.keys(rest).length) file.tokens = rest
    if (Object.keys(vars).some(k => k.startsWith('wall-'))) notes.push('its wallpaper settings (wall-*) are not carried over')
  }
  if (raw.wallpaper) notes.push(`its live ASCII wallpaper "${String(raw.wallpaper)}" is not supported yet; the colours come along`)
  if (raw.deco) notes.push('its picker decoration (deco) is not used')
  if (hasCss) file.css = `${raw.id}.css`
  return { file, notes }
}
