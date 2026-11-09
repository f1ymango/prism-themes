// Every adjustable part of Prism, in one table: /prism set <key> <value>, /prism reset <key|all>.
// Pure: register.tsx stores the values ($.store 'settings') and hands them to resolve().

export type SettingSpec =
  | { type: 'number'; min: number; max: number; unit?: string }
  | { type: 'choice'; choices: readonly string[] }

export type SettingDef = {
  key: string
  spec: SettingSpec
  /** what applies when unset; undefined: the theme decides */
  fallback?: number | string
  help: string
}

export const SETTINGS: SettingDef[] = [
  { key: 'panels.style', spec: { type: 'choice', choices: ['glass', 'clear', 'solid'] }, fallback: 'glass',
    help: 'side panels over a background: frosted glass, fully clear, or left as they are' },
  { key: 'panels.tint', spec: { type: 'number', min: 0, max: 0.9 }, fallback: 0.4,
    help: 'how strongly glass panels are tinted (lower is clearer)' },
  { key: 'panels.blur', spec: { type: 'number', min: 0, max: 40, unit: 'px' }, fallback: 14,
    help: 'blur behind glass panels (0 is crisp)' },
  { key: 'composer.tint', spec: { type: 'number', min: 0, max: 0.9 }, fallback: 0.6,
    help: 'how strongly the box you type in is tinted over a background' },
  { key: 'composer.blur', spec: { type: 'number', min: 0, max: 40, unit: 'px' }, fallback: 10,
    help: 'blur behind the box you type in (0 is crisp)' },
  { key: 'background.dim', spec: { type: 'number', min: 0, max: 0.9 },
    help: 'veil over a picture or video background (unset: the theme\'s own, or 0.25)' },
  { key: 'background.fit', spec: { type: 'choice', choices: ['cover', 'contain'] },
    help: 'cover fills the window, contain shows the whole picture (unset: the theme\'s own)' },
  { key: 'background.interval', spec: { type: 'number', min: 5, max: 3600, unit: 's' },
    help: 'seconds per picture in a slideshow (unset: the theme\'s own, or 60)' },
  { key: 'text.halo', spec: { type: 'number', min: 0, max: 20, unit: 'px' }, fallback: 8,
    help: 'glow around text over a background, for readability (0 turns it off)' },
  { key: 'reactions', spec: { type: 'choice', choices: ['on', 'off'] }, fallback: 'on',
    help: 'composer glow while a tool runs, shake on errors, edge glow while waiting for you' },
]

/** The short commands that came first, kept working: /prism glass 0.3 is /prism set panels.tint 0.3. */
export const ALIASES: Record<string, string> = {
  glass: 'panels.tint', blur: 'panels.blur', panels: 'panels.style',
  dim: 'background.dim', fit: 'background.fit', every: 'background.interval',
}

export type Settings = Record<string, number | string>

export const defOf = (key: string) => SETTINGS.find(s => s.key === key)

/** A key as typed (or a shortcut) → the setting, or a list of the keys there are. */
export const findSetting = (key: string): SettingDef | string => {
  const k = ALIASES[key.toLowerCase()] ?? key.toLowerCase()
  return defOf(k) ?? `No setting "${key}". The settings are: ${SETTINGS.map(s => s.key).join(', ')}.`
}

/** A value as typed → the value to store, or why not. Numbers may carry their unit (`0px`, `30s`). */
export const parseValue = (def: SettingDef, raw: string): { value: number | string } | { error: string } => {
  const v = raw.trim().toLowerCase()
  const s = def.spec
  if (s.type === 'choice') {
    return s.choices.includes(v) ? { value: v } : { error: `${def.key} is one of: ${s.choices.join(', ')}` }
  }
  const n = Number(s.unit ? v.replace(new RegExp(`${s.unit}$`), '') : v)
  if (v === '' || !Number.isFinite(n) || n < s.min || n > s.max) {
    return { error: `${def.key} is a number from ${s.min} to ${s.max}${s.unit ? ` (${s.unit})` : ''}` }
  }
  return { value: n }
}

/** The stored settings, keeping only valid values for known keys. */
export const cleanSettings = (raw: unknown): Settings => {
  const out: Settings = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const def = defOf(k)
    if (!def || (typeof v !== 'number' && typeof v !== 'string')) continue
    const p = parseValue(def, String(v))
    if ('value' in p) out[k] = p.value
  }
  return out
}

/** Values stored by Prism before settings existed (/prism panels, glass, blur), moved into settings. */
export const migrateLegacy = (legacy: { panels?: unknown; panelTint?: unknown; panelBlur?: unknown }): Settings =>
  cleanSettings({ 'panels.style': legacy.panels, 'panels.tint': legacy.panelTint, 'panels.blur': legacy.panelBlur })

const show = (def: SettingDef, v: number | string | undefined) =>
  v === undefined ? 'the theme\'s own' : `${v}${def.spec.type === 'number' && def.spec.unit ? def.spec.unit : ''}`

/** One line per setting: its value, and what it is when unset. */
export const describeSettings = (settings: Settings): string[] =>
  SETTINGS.map(def => {
    const set = settings[def.key]
    const range = def.spec.type === 'choice' ? def.spec.choices.join('|') : `${def.spec.min}–${def.spec.max}${def.spec.unit ?? ''}`
    const now = set !== undefined ? `${show(def, set)} (set)` : show(def, def.fallback)
    return `${def.key.padEnd(20)} ${now.padEnd(18)} ${range.padEnd(18)} ${def.help}`
  })

/** The settings you changed, compactly, for the strip: "panels.blur 0px · panels.tint 0.55". */
export const changedSummary = (settings: Settings): string =>
  SETTINGS.filter(d => settings[d.key] !== undefined).map(d => `${d.key} ${show(d, settings[d.key])}`).join(' · ')
