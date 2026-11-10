import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Discovery } from '../core/discover'
import { alertText, describeError, doctorLines, healthFile, partName, record, settle, stripText } from '../core/health'
import type { HealthLevel, HealthProblem } from '../core/health'
import type { CustomBackground } from '../core/media'
import { gradientSvg, resolve } from '../core/resolve'
import type { Panels, Theme } from '../core/resolve'
import { pickRule } from '../core/schema'
import { ALIASES, changedSummary, cleanSettings, describeSettings, findSetting, migrateLegacy, parseValue } from '../core/settings'
import type { Settings } from '../core/settings'
import { THEMES } from '../core/themes'
import type { Custom, Found, LibraryInfo, Tier1, Tier2 } from '../types'
import {
  discover, ensureAssets, importV1, inspectBackground, install, loadLibrary, nextPulseN, providerFor, readPayloadId,
  listRemoved, removeEvent, removeTheme, restoreTheme, slotOf, sweepEvents, syncInstall, tier2Of, uninstall, VERSION, writeEvent,
  writeHealth, writePayload,
} from './host'
import type { Library, PulseKind, SessionEvent, SessionState } from './host'

const P = 'prism-themes'
const isOpen = atom({ plugin: 'prism-themes', key: 'isOpen' } as const, false)
const isBusy = atom({ plugin: 'prism-themes', key: 'isBusy' } as const, false)
const current = atom({ plugin: 'prism-themes', key: 'current' } as const, 'claude')
const tier1 = atom({ plugin: 'prism-themes', key: 'tier1' } as const, null as Tier1 | null)
const tier2 = atom({ plugin: 'prism-themes', key: 'tier2' } as const, null as Tier2 | null)
const found = atom({ plugin: 'prism-themes', key: 'found' } as const, null as Found | null)
const custom = atom({ plugin: 'prism-themes', key: 'custom' } as const, null as Custom | null)
const panels = atom({ plugin: 'prism-themes', key: 'panels' } as const, 'glass' as Panels)
const libraryInfo = atom({ plugin: 'prism-themes', key: 'libraryInfo' } as const, null as LibraryInfo | null)
const health = atom({ plugin: 'prism-themes', key: 'health' } as const, [] as HealthProblem[])

/** Parts of Prism that failed in this session (core/health.ts); a part leaves the list once it works again. */
const problems: HealthProblem[] = []
/** The Claude Code version this session runs on, and the last one Prism started on with no errors. */
let engineVersion: string | undefined
let lastGood: string | undefined
/** Whether this module load set the session's backdrop, so a switch away clears only Prism's own. */
let backdropSet = false

let discovery: Discovery = { evidence: [] }
let event: SessionEvent = { pulse: null, state: 'idle', stateAt: 0 }
let library: Library = { themes: [], problems: [], rules: [], ruleErrors: [] }
let cwd = ''
/** set once the person picks a theme in this session: rules stop choosing for it */
let manual = false
let ruleTimer: unknown
/** Stops a $.clock timer: a Timer with cancel() now; a stop function before Claude Code 2.1.321. */
const stopTimer = (t: unknown) => { if (typeof t === 'function') t(); else (t as { cancel?: () => void } | undefined)?.cancel?.() }
const mediaCache = new Map<string, { key: string; bg?: CustomBackground; error?: string }>()

const allThemes = (): Theme[] => [...THEMES.map(t => ({ ...t, source: 'builtin' as const })), ...library.themes]
const themeById = (id: string | undefined) => allThemes().find(t => t.id === id)

const tier2Ready = (t: Tier2 | null): t is Tier2 & { slot: string } =>
  !!t?.slot && (t.state === 'restart' || t.state === 'active')

/** Tells the strip and the page what is broken. Never fails. */
async function publishHealth($: EngineInterface) {
  try {
    await update($, health, () => [...problems])
    const slot = slotOf(discovery)
    if (slot && tier2Ready(await read($, tier2))) {
      await writeHealth($, slot, healthFile(problems, await $.clock.now(), engineVersion, lastGood))
    }
  } catch { /* the report itself must never break anything */ }
}

/** Runs one part of Prism. A failure is recorded under the part's name (and logged) instead of stopping the rest. */
async function guard<T>($: EngineInterface, part: string, work: () => Promise<T>, level: HealthLevel = 'error'): Promise<T | undefined> {
  try {
    const out = await work()
    if (settle(problems, part)) await publishHealth($)
    return out
  } catch (err) {
    const detail = describeError(err)
    $.ui.log(`prism-themes: ${partName(part)} failed: ${detail}`)
    if (record(problems, { part, level, detail })) await publishHealth($)
    return undefined
  }
}

const failure = (part: string) => problems.find(p => p.part === part)?.detail ?? 'unknown error'

async function refresh($: EngineInterface) {
  discovery = await discover($)
  const { os, userData, source, appStartedMs, evidence } = discovery
  await update($, found, () => ({ os, userData, source, appStartedMs, evidence }))
  const t2 = await tier2Of($, discovery)
  await update($, tier2, () => t2)
  return t2
}

async function reloadLibrary($: EngineInterface) {
  library = await loadLibrary($, THEMES)
  const minutes = await localMinutes($)
  const rule = pickRule(library.rules, { cwd, minutes })
  await update($, libraryInfo, () => ({
    dir: library.dir ?? '',
    themes: library.themes.map(t => ({ id: t.id, name: t.name })),
    problems: library.problems.filter(p => p.errors.length).length,
    warnings: library.problems.filter(p => !p.errors.length).length,
    ruleUse: rule?.use,
  }))
  return rule
}

async function localMinutes($: EngineInterface) {
  const d = new Date(await $.clock.now())
  return d.getHours() * 60 + d.getMinutes()
}

async function loadCustom($: EngineInterface): Promise<CustomBackground | undefined> {
  const bg = (await $.store.get('background')) as CustomBackground | undefined
  return bg && Array.isArray(bg.files) && bg.files.length ? bg : undefined
}

/** Every /prism set value. The first time, the values older versions kept on their own move in. */
async function loadSettings($: EngineInterface): Promise<Settings> {
  const raw = await $.store.get('settings')
  if (raw && typeof raw === 'object') return cleanSettings(raw)
  const moved = migrateLegacy({
    panels: await $.store.get('panels'), panelTint: await $.store.get('panelTint'), panelBlur: await $.store.get('panelBlur'),
  })
  await $.store.set('settings', moved)
  return moved
}
const num = (s: Settings, k: string) => (typeof s[k] === 'number' ? (s[k] as number) : undefined)
const choice = (s: Settings, k: string) => (typeof s[k] === 'string' ? (s[k] as string) : undefined)

async function showCustom($: EngineInterface, bg: CustomBackground | undefined) {
  await update($, custom, () => bg
    ? { provider: bg.provider, count: bg.files.length, name: bg.files[0]!.path.split(/[\\/]/).pop() ?? '', interval: bg.interval, fit: bg.fit, dim: bg.dim }
    : null)
}

/** A theme's own picture, video or folder, checked once per change of the file (C7). */
async function themeMedia($: EngineInterface, t: Theme | undefined): Promise<CustomBackground | undefined> {
  if (!t?.media || !discovery.os) return undefined
  const st = await $.fs.stat(t.media.path).catch(() => undefined)
  const key = st ? `${st.kind}|${st.size}|${st.mtimeMs}` : 'missing'
  let hit = mediaCache.get(t.media.path)
  if (!hit || hit.key !== key) {
    const got = await inspectBackground($, discovery.os, t.media.path)
    const provider = providerFor(got.files)
    hit = provider && !got.error
      ? { key, bg: { files: got.files, provider, interval: t.media.interval, fit: t.media.fit, dim: t.media.dim } }
      : { key, error: got.error ?? 'those files cannot be shown together' }
    mediaCache.set(t.media.path, hit)
    if (hit.error) $.ui.log(`prism-themes: ${t.name}'s background: ${hit.error}`)
  }
  return hit.bg
}

/** The payload for the page. Background: yours (/prism bg), else the theme's own file, else its gradient. */
async function payloadFor($: EngineInterface, id: string, slot: string) {
  const t = themeById(id)
  const bg = (await loadCustom($)) ?? (await themeMedia($, t))
  const files = discovery.os ? await ensureAssets($, discovery.os, slot, bg) : []
  const t1 = await read($, tier1)
  const s = await loadSettings($)
  const fit = choice(s, 'background.fit')
  return resolve(t, {
    panels: choice(s, 'panels.style') as Panels | undefined,
    panelTint: num(s, 'panels.tint'),
    panelBlur: num(s, 'panels.blur'),
    composerTint: num(s, 'composer.tint'),
    composerBlur: num(s, 'composer.blur'),
    haloSize: num(s, 'text.halo'),
    reactions: choice(s, 'reactions') !== 'off',
    backgroundByPage: !!t?.background && !t1?.isDrawn,
    media: bg && files.length
      ? {
        provider: bg.provider, files,
        interval: num(s, 'background.interval') ?? bg.interval,
        fit: fit === 'cover' || fit === 'contain' ? fit : bg.fit,
        dim: num(s, 'background.dim') ?? bg.dim,
      }
      : undefined,
  })
}

const statusOf = (t: Theme | undefined, kind: 'idle' | 'tool' | 'error' | 'done', tool = '') =>
  t ? (t.status?.[kind] ?? (kind === 'idle' ? `◆ ${t.name}` : undefined))?.split('{tool}').join(tool) : undefined

async function applyTheme($: EngineInterface, id: string) {
  const t = themeById(id)
  await update($, current, () => (t ? t.id : 'claude'))
  await $.store.set('current', t ? t.id : 'claude')
  // The official backdrop ($.theme.set from Claude Code 2.1.321; $.ui.backdrop before). Optional: when it fails or
  // nothing draws it, the extension draws the background, so a failure here is a note, not an error.
  if (t?.background && !(await loadCustom($))) {
    const res = await guard($, 'backdrop',
      () => $.theme.set({ backdrop: { id: t.id, glass: { blur: 14, opacity: 0.55, tint: t.palette.bg } } }), 'note')
    if (res) backdropSet = true
    await update($, tier1, () => (!res ? { isDrawn: false, reason: `this Claude Code could not set one: ${failure('backdrop')}` }
      : res.isDrawn ? { isDrawn: true } : { isDrawn: false, reason: res.reason }))
  } else if (backdropSet) {
    // only a backdrop Prism set: $.theme.clear would also wipe another plugin's
    await guard($, 'backdrop', () => $.theme.clear(), 'note')
    backdropSet = false
  }
  const t2 = await read($, tier2)
  if (tier2Ready(t2)) await writePayload($, t2.slot, await payloadFor($, t ? t.id : 'claude', t2.slot))
  const effective = (choice(await loadSettings($), 'panels.style') as Panels | undefined) ?? t?.panels ?? 'glass'
  await update($, panels, () => effective)
  $.ui.status(statusOf(t, 'idle'))
}

async function pickTheme($: EngineInterface, id: string) {
  manual = true
  const t = themeById(id)
  const name = t ? t.name : "Claude's own look"
  const ok = await guard($, 'apply', async () => { await applyTheme($, id); return true })
  $.ui.toast(ok ? (t ? `Theme: ${name}` : name)
    : `Prism couldn't switch to ${name}: ${failure('apply')}. The page may still show the old theme. /prism doctor`)
}

/** Rules choose the theme until the person picks one in this session; time rules are checked each minute. */
async function followRules($: EngineInterface) {
  if (manual) return
  const rule = pickRule(library.rules, { cwd, minutes: await localMinutes($) })
  await update($, libraryInfo, i => (i ? { ...i, ruleUse: rule?.use } : i))
  if (rule && rule.use !== (await read($, current)) && (rule.use === 'claude' || themeById(rule.use))) {
    await guard($, 'apply', () => applyTheme($, rule.use))
  }
}

async function runBusy($: EngineInterface, work: () => Promise<void>) {
  if (await read($, isBusy)) return
  await update($, isBusy, () => true)
  try {
    await work()
  } finally {
    await update($, isBusy, () => false)
  }
}

async function onInstall($: EngineInterface) {
  await runBusy($, async () => {
    const done = await guard($, 'install', async () => {
      await refresh($)
      const out = await install($, discovery, {})
      $.ui.toast(out.message)
      await refresh($)
      if (out.ok) await applyTheme($, await read($, current)) // write the real payload now that the slot is ours
      return true
    })
    if (!done) $.ui.toast(`Prism couldn't install the extension: ${failure('install')}. /prism doctor`)
  })
}

async function onRemove($: EngineInterface) {
  await runBusy($, async () => {
    const done = await guard($, 'install', async () => {
      await refresh($)
      const out = await uninstall($, discovery)
      $.ui.toast(out.message)
      await refresh($)
      return true
    })
    if (!done) $.ui.toast(`Prism couldn't remove the extension: ${failure('install')}. /prism doctor`)
  })
}

/** /prism doctor: everything the mod knows, in one place (C9). */
async function doctor($: EngineInterface): Promise<string> {
  await guard($, 'discover', () => refresh($))
  const rule = await guard($, 'library', () => reloadLibrary($))
  const t1 = await read($, tier1)
  const t2 = await read($, tier2)
  const bg = await loadCustom($)
  const lines = [
    `Prism ${VERSION} — theme: ${(await read($, current))}${manual ? ' (picked in this session)' : rule ? ` (rule → ${rule.use})` : ''}`,
    '',
    'Health',
    ...doctorLines(problems, engineVersion, lastGood),
    '',
    'Claude Desktop',
    ...discovery.evidence.map(e => `  ${e}`),
    `  official backdrop: ${!t1 ? 'not tried yet' : t1.isDrawn ? 'drawing' : `unavailable (${t1.reason ?? '?'})`}`,
    `  extension: ${t2?.state ?? 'unknown'}${t2?.slot ? ` at ${t2.slot}` : ''}`,
    '',
    `Your themes: ${library.dir ? `${library.dir}\\themes` : 'no home folder'}`,
    `  ${library.themes.length ? library.themes.map(t => `${t.name} (${t.id})`).join(', ') : 'none yet'}`,
    ...library.problems.flatMap(p => [
      `  ${p.file}:`,
      ...p.errors.map(e => `    ✗ ${e}`),
      ...p.warnings.map(w => `    ! ${w}`),
    ]),
    '',
    `Rules: ${library.rules.length} (${library.dir ? `${library.dir}\\rules.json` : '—'})`,
    ...library.ruleErrors.map(e => `  ✗ ${e}`),
    `  for ${cwd || 'this session'} now: ${rule ? `use ${rule.use}` : 'no rule matches'}`,
    '',
    `Background: ${bg ? `${bg.provider}, ${bg.files.length} file(s)` : 'none of your own'}; side panels: ${await read($, panels)}`,
    '',
    'Settings (/prism set <key> <value>, /prism reset <key|all>):',
    ...describeSettings(await loadSettings($)).map(l => `  ${l}`),
  ]
  return lines.join('\n')
}

/** /prism set <key> <value> (and its shortcuts): validate, store, apply, and say what changed. */
async function changeSetting($: EngineInterface, key: string, raw: string): Promise<string> {
  const def = findSetting(key)
  if (typeof def === 'string') return def
  const settings = await loadSettings($)
  if (raw.trim().toLowerCase() === 'default') {
    delete settings[def.key]
  } else {
    if (!raw.trim()) {
      const now = settings[def.key] ?? def.fallback
      return `${def.key}: ${now ?? 'the theme\'s own'}. ${def.help}. Change it with /prism set ${def.key} <value>.`
    }
    const parsed = parseValue(def, raw)
    if ('error' in parsed) return `Usage: /prism set ${def.key} <value> — ${parsed.error}, or default`
    settings[def.key] = parsed.value
  }
  await $.store.set('settings', settings)
  await applyTheme($, await read($, current))
  const v = settings[def.key]
  const unit = def.spec.type === 'number' && def.spec.unit ? def.spec.unit : ''
  return `${def.key}: ${v === undefined ? `back to its default (${def.fallback ?? 'the theme\'s own'})` : `${v}${unit}`}. ${def.help}.`
}

/** /prism <word> ...: settings and tools. */
async function setting($: EngineInterface, args: string): Promise<string> {
  const [word = ''] = args.trim().split(/\s+/)
  const value = args.trim().slice(word.length).trim().replace(/^["']|["']$/g, '')
  const bg = await loadCustom($)
  let next: CustomBackground | undefined = bg
  switch (word.toLowerCase()) {
    case 'bg': {
      if (!value) return 'Usage: /prism bg <image, SVG or video file, or a folder> — or /prism bg off'
      if (value === 'off') { next = undefined; break }
      if (!discovery.os) await refresh($)
      if (!discovery.os) return 'Custom backgrounds need Windows or macOS.'
      const got = await inspectBackground($, discovery.os, value)
      if (got.error) return got.error
      const provider = providerFor(got.files)
      if (!provider) return 'Those files cannot be shown together.'
      next = { files: got.files, provider, interval: bg?.interval ?? 60, fit: bg?.fit ?? 'cover', dim: bg?.dim ?? 0.25 }
      if (got.skipped.length) $.ui.log(`prism-themes: skipped ${got.skipped.length}: ${got.skipped.slice(0, 5).join('; ')}`)
      break
    }
    case 'set': {
      // /prism set → every setting; /prism set <key> <value> → change one
      const [key = '', ...rest] = value.split(/\s+/)
      if (!key) return ['Prism settings (/prism set <key> <value>, /prism reset <key|all>):', '', ...describeSettings(await loadSettings($))].join('\n')
      return changeSetting($, key, rest.join(' '))
    }
    case 'reset': {
      if (!value) return 'Usage: /prism reset <key> — or /prism reset all'
      const settings = await loadSettings($)
      let done = 'All settings are back to their defaults.'
      if (value.toLowerCase() === 'all') {
        await $.store.set('settings', {})
      } else {
        const def = findSetting(value)
        if (typeof def === 'string') return def
        delete settings[def.key]
        await $.store.set('settings', settings)
        done = `${def.key} is back to its default (${def.fallback ?? 'the theme\'s own'}).`
      }
      await applyTheme($, await read($, current))
      return done
    }
    case 'use': {
      if (value !== 'claude' && !themeById(value)) return `No theme "${value}". /prism doctor lists yours.`
      await pickTheme($, value)
      return `Theme: ${themeById(value)?.name ?? "Claude's own look"} (for this session; rules resume in the next).`
    }
    case 'reload': {
      await reloadLibrary($)
      if (!manual) await followRules($)
      if (themeById(await read($, current))) await applyTheme($, await read($, current))
      const i = await read($, libraryInfo)
      return `Reloaded: ${i?.themes.length ?? 0} theme(s) of yours${i?.problems ? `, ${i.problems} with errors (/prism doctor)` : ''}.`
    }
    case 'import': {
      if (!value) return 'Usage: /prism import <folder of v1 themes>, e.g. %USERPROFILE%\\.claude\\themes-for-claude'
      const out = await importV1($, value)
      await reloadLibrary($)
      return out.join('\n')
    }
    case 'remove':
    case 'delete': {
      if (!value) return 'Usage: /prism remove <id> — moves one of your themes out of the themes folder (/prism restore <id> brings it back)'
      if (!discovery.os) await refresh($)
      if (!discovery.os) return 'Removing themes needs Windows or macOS.'
      const id = value.toLowerCase()
      const out = await removeTheme($, discovery.os, id, THEMES.map(t => t.id))
      if (!out.ok) return out.message
      await reloadLibrary($)
      // the theme in force is gone: back to what the rules say, else Claude's own look
      if ((await read($, current)) === id) {
        const rule = pickRule(library.rules, { cwd, minutes: await localMinutes($) })
        await applyTheme($, rule && themeById(rule.use) ? rule.use : 'claude')
      }
      const ruled = library.rules.some(r => r.use === id) ? ' rules.json still names it; those rules are skipped until you change them.' : ''
      return out.message + ruled
    }
    case 'restore': {
      const removed = await listRemoved($)
      if (!value) {
        return removed.length
          ? ['Removed themes (/prism restore <id>):', ...removed.map(r => `  ${r.id}  (${r.folder})`)].join('\n')
          : 'No removed themes.'
      }
      if (!discovery.os) await refresh($)
      if (!discovery.os) return 'Restoring themes needs Windows or macOS.'
      const out = await restoreTheme($, discovery.os, value.toLowerCase())
      if (out.ok) await reloadLibrary($)
      return out.message
    }
    case 'doctor':
      return doctor($)
    default:
      // the short commands that came first: /prism glass 0.3 is /prism set panels.tint 0.3
      if (ALIASES[word.toLowerCase()]) return changeSetting($, word, value)
      return `Unknown: ${word}. Try /prism, /prism use <id>, /prism bg <file|folder>, /prism bg off, /prism set (every adjustable ` +
        'part: panels, composer, background, text halo, reactions), /prism reset <key|all>, /prism remove <id>, /prism restore <id>, /prism import <folder>, /prism reload, /prism doctor'
  }
  if (next) await $.store.set('background', next)
  else await $.store.delete('background')
  await showCustom($, next)
  await applyTheme($, await read($, current))
  const t2 = await read($, tier2)
  const note = tier2Ready(t2) ? '' : ' It shows once the extension is installed (/prism → Install extension).'
  return next ? `Background: ${next.provider}, ${next.files.length} file(s), fit ${next.fit}, dim ${next.dim}.${note}` : 'Background removed.'
}

/** C5: tell this session's window what Claude is doing. Never blocks or fails the event it rides on. */
function signal($: EngineInterface, kind: PulseKind | '', tool: string, now: SessionState = event.state) {
  void (async () => {
    const at = await $.clock.now()
    event = {
      pulse: kind ? { n: nextPulseN(), kind, tool, at } : event.pulse,
      state: now,
      stateAt: now === event.state ? event.stateAt : at,
    }
    const t2 = await read($, tier2)
    if (tier2Ready(t2)) await guard($, 'events', () => writeEvent($, t2.slot, event), 'note')
    if (kind) {
      const text = statusOf(themeById(await read($, current)), kind, tool)
      if (text) $.ui.status(text)
    }
  })().catch(() => {})
}

const tier1Text = (t: Tier1 | null) =>
  !t ? 'not tried yet (pick a theme with a background)'
    : t.isDrawn ? 'drawing'
      : /no attached desktop client/.test(t.reason ?? '') ? 'unavailable: this app version has no backdrop layer'
        : `unavailable: ${t.reason ?? 'no reason given'}`

const TIER2_TEXT: Record<Tier2['state'], string> = {
  unsupported: 'not supported on this system',
  missing: 'not installed',
  restart: 'installed, waiting for a full restart of Claude Desktop',
  active: 'active',
}

const customText = (c: Custom | null) =>
  !c ? 'the theme\'s own (set one with /prism bg <file or folder>)'
    : c.provider === 'slideshow' ? `slideshow of ${c.count} pictures, every ${c.interval}s, dim ${c.dim}`
      : `${c.name} (${c.provider}), ${c.fit}, dim ${c.dim}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const out = await next(e)
    cwd = e.cwd
    manual = false
    await guard($, 'commands', () => $.command.register({ name: 'prism', description: 'Prism themes: pick a theme, /prism bg <file|folder>, /prism doctor' }))
    // Each part runs on its own: one that an update broke is reported, and the rest still start.
    engineVersion = (await guard($, 'version', () => $.session.version(), 'note'))?.version
    const stored = await $.store.get('lastGood').catch(() => undefined)
    lastGood = typeof stored === 'string' ? stored : undefined
    const t2 = await guard($, 'discover', () => refresh($))
    if (t2 && (await guard($, 'extension', () => syncInstall($, discovery)))) {
      $.ui.toast('Prism\'s extension was updated. Restart Claude Desktop to load it.')
    }
    await sweepEvents($, discovery).catch(() => undefined)
    const rule = await guard($, 'library', async () => {
      await showCustom($, await loadCustom($))
      return reloadLibrary($)
    })
    const saved = rule?.use ?? (await readPayloadId($, t2?.slot).catch(() => undefined)) ?? (await $.store.get('current').catch(() => undefined))
    await guard($, 'apply', () => applyTheme($, typeof saved === 'string' ? saved : 'claude'))
    stopTimer(ruleTimer)
    ruleTimer = library.rules.some(r => r.time) ? $.clock.every(60000, () => void followRules($).catch(() => undefined)) : undefined
    // Like the Codex port's build check: remember the version Prism last started on cleanly, and say so when an
    // update is the likely cause.
    const alert = alertText(problems, engineVersion, lastGood)
    if (alert) {
      $.ui.toast(alert)
    } else if (engineVersion && engineVersion !== lastGood) {
      await $.store.set('lastGood', engineVersion).catch(() => undefined)
      lastGood = engineVersion
    }
    await publishHealth($)
    return out
  })

  on('session.end', async ($, e, next) => {
    stopTimer(ruleTimer)
    await removeEvent($, discovery).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'prism' }, async ($, e) => {
    await refresh($).catch(() => undefined)
    if (e.args.trim()) return { text: await setting($, e.args).catch(err => `Prism: ${String(err)}`) }
    await reloadLibrary($).catch(() => undefined)
    const open = await update($, isOpen, o => !o)
    return { text: open ? 'Prism strip opened above the prompt.' : 'Prism strip closed.' }
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) signal($, '', '', 'thinking')
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id) signal($, '', e.tool, 'waiting')
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    signal($, 'tool', e.tool, 'thinking')
    const result = await next(e)
    // the permission question (if any) is over once the call returns: back to thinking either way
    signal($, result.isError ? 'error' : '', e.tool, 'thinking')
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) signal($, 'done', '', 'idle')
    return next(e)
  })

  on('ui.render', { component: 'Backdrop' }, async ($, e, next) => {
    if (e.props.plugin !== P) return next(e)
    const t = themeById(e.props.id)
    const els = $.ui.resolve(e)
    if (!t?.background || !('Svg' in els)) return next(e)
    const { Svg } = els
    return <Svg source={gradientSvg(t.background)} alt={`${t.name} background`} />
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOpen))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await read($, current)
    const t1 = await read($, tier1)
    const t2 = await read($, tier2)
    const f = await read($, found)
    const c = await read($, custom)
    const lib = await read($, libraryInfo)
    const busy = await read($, isBusy)
    const broken = stripText(await read($, health))
    const worn = themeById(now)
    const st = t2?.state ?? 'unsupported'
    const needs = (c || worn?.background || worn?.media) && !t1?.isDrawn && st !== 'active'
      ? `${c ? 'Your background' : `${worn!.name}'s background`} needs the extension (or a Claude Desktop with the backdrop layer).` : undefined
    const row = (title: string, items: { id: string; name: string }[]) => (
      <Box key={`row-${title}`} flexDirection="column">
        <Text dimColor>{title}</Text>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {items.map(t => (
            <Button key={`use-${t.id}`} label={t.id === now ? `✓ ${t.name}` : t.name} dimColor={t.id !== now}
              onPress={() => pickTheme($, t.id)} />
          ))}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="row" alignItems="center" justifyContent="space-between">
          <Text>
            <Text weight="semibold">Prism</Text>
            <Text dimColor>{`  ·  ${worn ? `${worn.name}${worn.tagline ? `: ${worn.tagline}` : ''}` : "Claude's own look"}`}</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            {c ? <Button key="bg-off" label="Clear background" dimColor onPress={() => setting($, 'bg off').then(m => $.ui.toast(m))} /> : null}
            {st === 'missing'
              ? <Button key="install" label={busy ? 'Installing…' : 'Install extension'} variant="primary" onPress={() => onInstall($)} />
              : st === 'restart' || st === 'active'
                ? <Button key="remove" label={busy ? 'Removing…' : 'Remove extension'} dimColor onPress={() => onRemove($)} />
                : null}
            <Button key="close" role="dismiss" label="Close" onPress={() => update($, isOpen, () => false)} />
          </Box>
        </Box>
        <Box flexDirection="column">
          {broken ? <Text color="error">{broken}</Text> : null}
          <Text dimColor>{`Backdrop (official API): ${c || worn?.media
            ? 'not used: picture and video backgrounds are drawn by the extension'
            : tier1Text(t1)}`}</Text>
          <Text dimColor>{`Extension: ${TIER2_TEXT[st]}`}</Text>
          <Text dimColor>{`Background: ${customText(c)}`}</Text>
          <Text dimColor>{`Adjusted: ${changedSummary(await loadSettings($)) || 'nothing yet'} (/prism set lists every setting)`}</Text>
          <Text dimColor>{`Claude data folder: ${f?.userData ?? 'not found'}${f?.source ? ` (from ${f.source})` : ''}`}</Text>
          {lib?.ruleUse && !manual ? <Text dimColor>{`Chosen by your rules: ${themeById(lib.ruleUse)?.name ?? lib.ruleUse}`}</Text> : null}
          {lib?.problems ? <Text color="warning">{`${lib.problems} theme file(s) of yours have errors: /prism doctor`}</Text> : null}
          {needs ? <Text color="warning">{needs}</Text> : null}
        </Box>
        {row('Built-in', [{ id: 'claude', name: 'Claude' }, ...THEMES])}
        {row(`Yours (${lib?.dir ? `${lib.dir}\\themes` : 'no folder'})`, lib?.themes.length ? lib.themes : [])}
        {lib?.themes.length
          ? <Text dimColor>{'  /prism remove <id> removes one of yours (/prism restore <id> brings it back).'}</Text>
          : <Text dimColor>{'  None yet. Ask Claude to "make me a theme", or /prism import <folder of v1 themes>.'}</Text>}
      </Box>
    )
  })
}
