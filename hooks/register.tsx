import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Discovery } from '../core/discover'
import type { CustomBackground } from '../core/media'
import { gradientSvg, resolve } from '../core/resolve'
import type { Panels, Theme } from '../core/resolve'
import { pickRule } from '../core/schema'
import { THEMES } from '../core/themes'
import type { Custom, Found, LibraryInfo, Tier1, Tier2 } from '../types'
import {
  discover, ensureAssets, importV1, inspectBackground, install, loadLibrary, nextPulseN, providerFor, readPayloadId,
  removeEvent, sweepEvents, syncInstall, tier2Of, uninstall, VERSION, writeEvent, writePayload,
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

let discovery: Discovery = { evidence: [] }
let event: SessionEvent = { pulse: null, state: 'idle', stateAt: 0 }
let library: Library = { themes: [], problems: [], rules: [], ruleErrors: [] }
let cwd = ''
/** set once the person picks a theme in this session: rules stop choosing for it */
let manual = false
let ruleTimer: (() => void) | undefined
const mediaCache = new Map<string, { key: string; bg?: CustomBackground; error?: string }>()

const allThemes = (): Theme[] => [...THEMES.map(t => ({ ...t, source: 'builtin' as const })), ...library.themes]
const themeById = (id: string | undefined) => allThemes().find(t => t.id === id)

const tier2Ready = (t: Tier2 | null): t is Tier2 & { slot: string } =>
  !!t?.slot && (t.state === 'restart' || t.state === 'active')

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

/** The person's explicit /prism panels choice, if any (a theme may set its own default). */
async function loadPanels($: EngineInterface): Promise<Panels | undefined> {
  const p = await $.store.get('panels')
  return p === 'glass' || p === 'clear' || p === 'solid' ? p : undefined
}

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
  return resolve(t, {
    panels: await loadPanels($),
    backgroundByPage: !!t?.background && !t1?.isDrawn,
    media: bg && files.length ? { provider: bg.provider, files, interval: bg.interval, fit: bg.fit, dim: bg.dim } : undefined,
  })
}

const statusOf = (t: Theme | undefined, kind: 'idle' | 'tool' | 'error' | 'done', tool = '') =>
  t ? (t.status?.[kind] ?? (kind === 'idle' ? `◆ ${t.name}` : undefined))?.split('{tool}').join(tool) : undefined

async function applyTheme($: EngineInterface, id: string) {
  const t = themeById(id)
  await update($, current, () => (t ? t.id : 'claude'))
  await $.store.set('current', t ? t.id : 'claude')
  if (t?.background && !(await loadCustom($))) {
    const res = await $.ui.backdrop({ id: t.id, glass: { blur: 14, opacity: 0.55, tint: t.palette.bg } })
    await update($, tier1, () => (res.isDrawn ? { isDrawn: true } : { isDrawn: false, reason: res.reason }))
  } else {
    await $.ui.backdrop(undefined)
  }
  const t2 = await read($, tier2)
  if (tier2Ready(t2)) await writePayload($, t2.slot, await payloadFor($, t ? t.id : 'claude', t2.slot))
  const effective = (await loadPanels($)) ?? t?.panels ?? 'glass'
  await update($, panels, () => effective)
  $.ui.status(statusOf(t, 'idle'))
}

async function pickTheme($: EngineInterface, id: string) {
  manual = true
  await applyTheme($, id)
  const t = themeById(id)
  $.ui.toast(t ? `Theme: ${t.name}` : "Claude's own look")
}

/** Rules choose the theme until the person picks one in this session; time rules are checked each minute. */
async function followRules($: EngineInterface) {
  if (manual) return
  const rule = pickRule(library.rules, { cwd, minutes: await localMinutes($) })
  await update($, libraryInfo, i => (i ? { ...i, ruleUse: rule?.use } : i))
  if (rule && rule.use !== (await read($, current)) && (rule.use === 'claude' || themeById(rule.use))) await applyTheme($, rule.use)
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
    await refresh($)
    const out = await install($, discovery, {})
    $.ui.toast(out.message)
    await refresh($)
    if (out.ok) await applyTheme($, await read($, current)) // write the real payload now that the slot is ours
  })
}

async function onRemove($: EngineInterface) {
  await runBusy($, async () => {
    await refresh($)
    const out = await uninstall($, discovery)
    $.ui.toast(out.message)
    await refresh($)
  })
}

/** /prism doctor: everything the mod knows, in one place (C9). */
async function doctor($: EngineInterface): Promise<string> {
  await refresh($)
  const rule = await reloadLibrary($)
  const t1 = await read($, tier1)
  const t2 = await read($, tier2)
  const bg = await loadCustom($)
  const lines = [
    `Prism ${VERSION} — theme: ${(await read($, current))}${manual ? ' (picked in this session)' : rule ? ` (rule → ${rule.use})` : ''}`,
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
  ]
  return lines.join('\n')
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
    case 'dim': {
      const n = Number(value)
      if (!bg || !Number.isFinite(n) || n < 0 || n > 0.9) return bg ? 'Usage: /prism dim <0 to 0.9>' : 'Set a background first: /prism bg <file>'
      next = { ...bg, dim: n }
      break
    }
    case 'fit':
      if (!bg || (value !== 'cover' && value !== 'contain')) return bg ? 'Usage: /prism fit cover|contain' : 'Set a background first: /prism bg <file>'
      next = { ...bg, fit: value }
      break
    case 'every': {
      const n = Number(value.replace(/s$/, ''))
      if (!bg || !Number.isFinite(n) || n < 5) return bg ? 'Usage: /prism every <seconds, 5 or more>' : 'Set a background first: /prism bg <folder>'
      next = { ...bg, interval: n }
      break
    }
    case 'panels': {
      if (value !== 'glass' && value !== 'clear' && value !== 'solid') return 'Usage: /prism panels glass|clear|solid'
      await $.store.set('panels', value)
      await applyTheme($, await read($, current))
      return `Side panels: ${value}. They follow a background (a theme's or yours); without one they stay as they are.`
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
    case 'doctor':
      return doctor($)
    default:
      return `Unknown: ${word}. Try /prism, /prism use <id>, /prism bg <file|folder>, /prism bg off, /prism dim 0.3, ` +
        '/prism fit contain, /prism every 30, /prism panels glass|clear|solid, /prism import <folder>, /prism reload, /prism doctor'
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
    if (tier2Ready(t2)) await writeEvent($, t2.slot, event)
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
    await $.command.register({ name: 'prism', description: 'Prism themes: pick a theme, /prism bg <file|folder>, /prism doctor' })
    try {
      const t2 = await refresh($)
      if (await syncInstall($, discovery)) $.ui.toast('Prism\'s extension was updated. Restart Claude Desktop to load it.')
      await sweepEvents($, discovery).catch(() => undefined)
      await showCustom($, await loadCustom($))
      const rule = await reloadLibrary($)
      const saved = rule?.use ?? (await readPayloadId($, t2.slot)) ?? (await $.store.get('current'))
      await applyTheme($, typeof saved === 'string' ? saved : 'claude')
      ruleTimer?.()
      ruleTimer = library.rules.some(r => r.time) ? $.clock.every(60000, () => void followRules($).catch(() => undefined)) : undefined
    } catch (err) {
      $.ui.log(`prism-themes: start failed: ${String(err)}`)
    }
    return out
  })

  on('session.end', async ($, e, next) => {
    ruleTimer?.()
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
          <Text dimColor>{`Backdrop (official API): ${c || worn?.media
            ? 'not used: picture and video backgrounds are drawn by the extension'
            : tier1Text(t1)}`}</Text>
          <Text dimColor>{`Extension: ${TIER2_TEXT[st]}`}</Text>
          <Text dimColor>{`Background: ${customText(c)}`}</Text>
          <Text dimColor>{`Side panels over it: ${await read($, panels)} (/prism panels glass|clear|solid)`}</Text>
          <Text dimColor>{`Claude data folder: ${f?.userData ?? 'not found'}${f?.source ? ` (from ${f.source})` : ''}`}</Text>
          {lib?.ruleUse && !manual ? <Text dimColor>{`Chosen by your rules: ${themeById(lib.ruleUse)?.name ?? lib.ruleUse}`}</Text> : null}
          {lib?.problems ? <Text color="warning">{`${lib.problems} theme file(s) of yours have errors: /prism doctor`}</Text> : null}
          {needs ? <Text color="warning">{needs}</Text> : null}
        </Box>
        {row('Built-in', [{ id: 'claude', name: 'Claude' }, ...THEMES])}
        {row(`Yours (${lib?.dir ? `${lib.dir}\\themes` : 'no folder'})`, lib?.themes.length ? lib.themes : [])}
        {lib?.themes.length ? null : <Text dimColor>{'  None yet. Ask Claude to "make me a theme", or /prism import <folder of v1 themes>.'}</Text>}
      </Box>
    )
  })
}
