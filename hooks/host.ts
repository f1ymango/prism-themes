// Everything that reaches outside the mod through `$`: discovery (C1), install lifecycle (C8), the payload bridge.
import type { EngineInterface } from 'claude-code'

import { SLOT_ID, fromProcesses, join, markerTarget, parseMacProcs, parseWinProcs, pick } from '../core/discover'
import type { Candidate, Discovery, OS } from '../core/discover'
import type { HealthFile } from '../core/health'
import { OUR_DIRS, OUR_FILES, OUR_HEALTH, OUR_JS, OUR_PAYLOAD, OUR_RECORD, hasOurs, parseRecord, withOurs, withoutOurs } from '../core/manifest'
import type { InstallRecord, Manifest } from '../core/manifest'
import { MAX_SLIDES, assetName, providerFor, refusal, sniff } from '../core/media'
import type { Checked, CustomBackground } from '../core/media'
import { safeCss } from '../core/resolve'
import type { Payload, Theme } from '../core/resolve'
import { convertV1Css, finalize, fromV1, parseRules, parseTheme } from '../core/schema'
import type { Draft, Rule } from '../core/schema'

export const VERSION = '0.6.0'
export type Tier2State = 'unsupported' | 'missing' | 'restart' | 'active'
export type Tier2 = { state: Tier2State; slot?: string }

const WIN_PROCS = "Get-CimInstance Win32_Process | Where-Object Name -eq 'claude.exe' | " +
  "ForEach-Object { if ($_.CreationDate) { '{0}|{1}' -f ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), $_.CommandLine } }"

export async function osOf($: EngineInterface): Promise<OS | undefined> {
  if (await $.env.get('APPDATA')) return 'windows'
  const home = await $.env.get('HOME')
  return home && (await $.fs.exists(join(home, 'Library', 'Application Support'))) ? 'macos' : undefined
}

async function isLive($: EngineInterface, path: string) {
  try {
    if (!(await $.fs.exists(join(path, 'config.json'))) || !(await $.fs.exists(join(path, 'Local Storage')))) return 0
    return (await $.fs.stat(join(path, 'config.json'))).mtimeMs || 1
  } catch {
    return 0
  }
}

async function candidate($: EngineInterface, path: string, source: Candidate['source']): Promise<Candidate> {
  const mtimeMs = await isLive($, path)
  return { path, source, live: mtimeMs > 0, mtimeMs }
}

/** C1: the running app's own --user-data-dir first, then the folders it may use, checked for live data. */
export async function discover($: EngineInterface): Promise<Discovery> {
  const os = await osOf($)
  const evidence: string[] = []
  if (!os) return { evidence: ['neither Windows nor macOS'] }
  const cands: Candidate[] = []
  let appStartedMs: number | undefined

  try {
    const { exitCode, stdout } = os === 'windows'
      ? await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', WIN_PROCS])
      : await $.process.run(['ps', '-axo', 'etime=,args='])
    const procs = exitCode === 0 ? (os === 'windows' ? parseWinProcs(stdout) : parseMacProcs(stdout, await $.clock.now())) : []
    const found = fromProcesses(procs)
    appStartedMs = found.appStartedMs
    evidence.push(`${procs.length} Claude process(es) running`)
    for (const d of found.dirs) {
      cands.push({ path: d, source: 'process', live: true, mtimeMs: Number.MAX_SAFE_INTEGER })
      evidence.push(`--user-data-dir=${d}`)
    }
  } catch (err) {
    evidence.push(`process query failed: ${String(err)}`)
  }

  if (os === 'windows') {
    const appData = (await $.env.get('APPDATA'))!
    const local = await $.env.get('LOCALAPPDATA')
    const classic = join(appData, 'Claude')
    if (await $.fs.exists(classic)) {
      const target = markerTarget((await $.fs.list(classic)).map(e => e.name))
      if (target && local) {
        evidence.push(`move marker → Claude-Data\\${target}`)
        cands.push(await candidate($, join(local, 'Claude-Data', target), 'marker'))
      }
      cands.push(await candidate($, classic, 'classic'))
    }
    const packages = local && join(local, 'Packages')
    if (packages && (await $.fs.exists(packages))) {
      for (const p of (await $.fs.list(packages)).filter(e => e.kind === 'dir' && e.name.startsWith('Claude_')))
        cands.push(await candidate($, join(packages, p.name, 'LocalCache', 'Roaming', 'Claude'), 'msix'))
    }
  } else {
    const home = (await $.env.get('HOME'))!
    cands.push(await candidate($, join(home, 'Library', 'Application Support', 'Claude'), 'macos'))
  }

  const best = pick(cands)
  if (best) evidence.push(`chose ${best.source}: ${best.path}`)
  else evidence.push('no folder with live Claude data found')
  return { os, userData: best?.path, source: best?.source, appStartedMs, evidence }
}

export const slotOf = (d: Discovery) => (d.userData ? join(d.userData, 'extensions', SLOT_ID) : undefined)

async function readText($: EngineInterface, path: string) {
  return String(await $.fs.read(path)).replace(/^﻿/, '')
}

async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readText($, path)) as T
  } catch {
    return undefined
  }
}

export async function readRecord($: EngineInterface, slot: string): Promise<InstallRecord | undefined> {
  return parseRecord(await readText($, join(slot, OUR_RECORD)).catch(() => ''))
}

/** Tier 2 can only be inferred: the page cannot answer the mod (FINDINGS S4/C2). */
export async function tier2Of($: EngineInterface, d: Discovery): Promise<Tier2> {
  const slot = slotOf(d)
  if (!slot) return { state: 'unsupported' }
  if (!hasOurs(await readJson<Manifest>($, join(slot, 'manifest.json')))) return { state: 'missing', slot }
  const record = await readRecord($, slot)
  const started = d.appStartedMs !== undefined && record !== undefined && d.appStartedMs > record.installedAt
  return { state: started ? 'active' : 'restart', slot }
}

export async function readPayloadId($: EngineInterface, slot: string | undefined): Promise<string | undefined> {
  if (!slot) return undefined
  const p = await readJson<Partial<Payload>>($, join(slot, OUR_PAYLOAD))
  return typeof p?.id === 'string' ? p.id : undefined
}

export async function writePayload($: EngineInterface, slot: string, payload: Payload | Record<string, never>) {
  await $.fs.write(join(slot, OUR_PAYLOAD), JSON.stringify(payload))
}

/** What is broken, for the page's notice; written only when it changes. */
export async function writeHealth($: EngineInterface, slot: string, health: HealthFile) {
  const path = join(slot, OUR_HEALTH)
  const text = JSON.stringify(health)
  const old = await readJson<HealthFile>($, path)
  if (old && JSON.stringify(old.problems) === JSON.stringify(health.problems) && old.version === health.version) return
  await $.fs.write(path, text)
}

async function userEnvIsSet($: EngineInterface, os: OS) {
  const { stdout } = os === 'windows'
    ? await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command',
      "[Environment]::GetEnvironmentVariable('REACT_PROFILE','User')"])
    : await $.process.run(['launchctl', 'getenv', 'REACT_PROFILE'])
  return stdout.trim() === '1'
}

const AGENT = 'com.prism-themes.react-profile'
const agentFile = (home: string) => join(home, 'Library', 'LaunchAgents', `${AGENT}.plist`)
const AGENT_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/launchctl</string><string>setenv</string><string>REACT_PROFILE</string><string>1</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`

async function setUserEnv($: EngineInterface, os: OS) {
  if (os === 'windows') {
    return (await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command',
      "[Environment]::SetEnvironmentVariable('REACT_PROFILE','1','User')"])).exitCode
  }
  await $.fs.write(agentFile((await $.env.get('HOME'))!), AGENT_PLIST)
  return (await $.process.run(['launchctl', 'setenv', 'REACT_PROFILE', '1'])).exitCode
}

async function clearUserEnv($: EngineInterface, os: OS) {
  if (os === 'windows') {
    await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command',
      "[Environment]::SetEnvironmentVariable('REACT_PROFILE',$null,'User')"])
    return
  }
  await $.process.run(['launchctl', 'unsetenv', 'REACT_PROFILE'])
  await $.process.run(['rm', '-f', agentFile((await $.env.get('HOME'))!)])
}

async function removePaths($: EngineInterface, os: OS, files: string[]) {
  if (!files.length) return 0
  return (await $.process.run(os === 'windows' ? ['cmd', '/c', 'del', '/q', ...files] : ['rm', '-f', '--', ...files])).exitCode
}

async function removeDir($: EngineInterface, os: OS, dir: string, recursive: boolean) {
  const argv = os === 'windows'
    ? ['cmd', '/c', 'rmdir', ...(recursive ? ['/s', '/q'] : []), dir]
    : recursive ? ['rm', '-rf', '--', dir] : ['rmdir', dir]
  return (await $.process.run(argv)).exitCode
}

async function removeOurDirs($: EngineInterface, os: OS, slot: string) {
  for (const dir of OUR_DIRS) if (await $.fs.exists(join(slot, dir))) await removeDir($, os, join(slot, dir), true)
}

export type Outcome = { ok: boolean; message: string }

/** prism.js with the shared role compiler pasted in (extension/compile.js, its `export` words taken out). */
export async function assembleScript($: EngineInterface) {
  const ext = `${$.plugin.root}/extension`
  const compile = (await readText($, `${ext}/compile.js`)).replace(/^export /gm, '')
  return (await readText($, `${ext}/${OUR_JS}`)).replace('/*@compile*/', () => compile)
}

/** C8 upgrade: after a mod update, refresh our script and manifest entries in the slot. True when anything changed. */
export async function syncInstall($: EngineInterface, d: Discovery): Promise<boolean> {
  const slot = slotOf(d)
  if (!slot) return false
  const manifestPath = join(slot, 'manifest.json')
  const manifest = await readJson<Manifest>($, manifestPath)
  if (!hasOurs(manifest)) return false
  const js = await assembleScript($)
  const merged = JSON.stringify(withOurs(manifest, VERSION), null, 2)
  const nowJs = await readText($, join(slot, OUR_JS)).catch(() => '')
  if (nowJs === js && JSON.stringify(manifest, null, 2) === merged) return false
  await $.fs.write(join(slot, OUR_JS), js)
  await $.fs.write(manifestPath, merged)
  return true
}

// C5 ---------------------------------------------------------------------------------------------------------------

export type SessionState = 'thinking' | 'waiting' | 'idle'
export type PulseKind = 'tool' | 'error' | 'done'
/**
 * The session's event file. A pulse (a tool started, failed, the turn ended) and the state are kept apart, so a
 * state change written a moment later never erases a pulse the page has not read yet (the engine raises tool.check
 * inside tool.call, so the two are written back to back).
 */
export type SessionEvent = {
  pulse: { n: number; kind: PulseKind; tool: string; at: number } | null
  state: SessionState
  stateAt: number
}
let eventN = Date.now() // so a reloaded module never repeats a number
export const nextPulseN = () => ++eventN

/** This window's session id, as the page sees it in its address (FINDINGS S3). */
export async function hostSessionId($: EngineInterface) {
  const id = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  return id && /^local_[\w-]{8,80}$/.test(id) ? id : undefined
}

export async function writeEvent($: EngineInterface, slot: string, ev: SessionEvent) {
  const id = await hostSessionId($)
  if (!id) return
  await $.fs.write(join(slot, 'events', `${id}.json`), JSON.stringify(ev))
}

export async function removeEvent($: EngineInterface, d: Discovery) {
  const slot = slotOf(d)
  const id = await hostSessionId($)
  if (!d.os || !slot || !id) return
  const path = join(slot, 'events', `${id}.json`)
  if (await $.fs.exists(path)) await removePaths($, d.os, [path])
}

/** Event files of sessions not seen for a week. */
export async function sweepEvents($: EngineInterface, d: Discovery) {
  const slot = slotOf(d)
  if (!d.os || !slot || !(await $.fs.exists(join(slot, 'events')))) return
  const weekAgo = (await $.clock.now()) - 7 * 86400000
  const old = (await $.fs.list(join(slot, 'events')))
    .filter(e => e.kind === 'file' && e.name.endsWith('.json') && e.mtimeMs < weekAgo).map(e => join(slot, 'events', e.name))
  await removePaths($, d.os, old)
}

// C3 + C7 ----------------------------------------------------------------------------------------------------------

const WIN_HEAD = "$f=[IO.File]::OpenRead($env:PRISM_FILE); $b=New-Object byte[] 512; $n=$f.Read($b,0,512); $f.Close(); " +
  "if ($n -gt 0) { ($b[0..($n-1)] | ForEach-Object { $_.ToString('x2') }) -join '' }"

/** The first 512 bytes of a file, as hex; the path goes through the environment, never into a command line. */
async function headHex($: EngineInterface, os: OS, path: string) {
  const { exitCode, stdout } = os === 'windows'
    ? await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', WIN_HEAD], { env: { PRISM_FILE: path } })
    : await $.process.run(['od', '-An', '-tx1', '-N512', '--', path])
  return exitCode === 0 ? stdout.replace(/\s+/g, '') : ''
}

async function check($: EngineInterface, os: OS, path: string): Promise<Checked | string> {
  const st = await $.fs.stat(path)
  if (st.kind !== 'file') return `${path} is not a file`
  const kind = sniff(await headHex($, os, path))
  const why = refusal(path, kind, st.size)
  return why ?? { path, kind: kind!, size: st.size, mtimeMs: st.mtimeMs }
}

/** C7: a file, or a folder of images, checked by content and size. A folder keeps the images it can and says why not. */
export async function inspectBackground($: EngineInterface, os: OS, path: string):
  Promise<{ files: Checked[]; skipped: string[]; error?: string }> {
  if (!(await $.fs.exists(path))) return { files: [], skipped: [], error: `Nothing at ${path}` }
  const st = await $.fs.stat(path)
  if (st.kind === 'file') {
    const one = await check($, os, path)
    return typeof one === 'string' ? { files: [], skipped: [], error: one } : { files: [one], skipped: [] }
  }
  if (st.kind !== 'dir') return { files: [], skipped: [], error: `${path} is neither a file nor a folder` }
  const files: Checked[] = []
  const skipped: string[] = []
  const entries = (await $.fs.list(path)).filter(e => e.kind === 'file').sort((a, b) => a.name.localeCompare(b.name))
  // a folder holding exactly one video (a Wallpaper Engine wallpaper: the video, a preview picture, project.json)
  // means that video
  const videos = entries.filter(e => /\.(mp4|webm|m4v)$/i.test(e.name))
  if (videos.length === 1) {
    const one = await check($, os, join(path, videos[0]!.name))
    if (typeof one !== 'string' && (one.kind === 'mp4' || one.kind === 'webm')) return { files: [one], skipped: [] }
  }
  for (const e of entries) {
    if (files.length >= MAX_SLIDES) { skipped.push(`${e.name}: past ${MAX_SLIDES} pictures`); continue }
    const one = await check($, os, join(path, e.name))
    if (typeof one === 'string') skipped.push(one)
    else if (one.kind === 'svg' || one.kind === 'mp4' || one.kind === 'webm') skipped.push(`${e.name}: a slideshow takes pictures only`)
    else files.push(one)
  }
  return files.length ? { files, skipped } : { files, skipped, error: `No pictures this mod accepts in ${path}` }
}

/** Copies the background's files into the slot (once per version of each file); drops copies no longer used. */
export async function ensureAssets($: EngineInterface, os: OS, slot: string, bg: CustomBackground | undefined) {
  const dir = join(slot, 'prism-assets')
  const want = new Map((bg?.files ?? []).map(f => [assetName(f), f]))
  const have = (await $.fs.exists(dir)) ? (await $.fs.list(dir)).filter(e => e.kind === 'file').map(e => e.name) : []
  for (const [name, f] of want) {
    if (have.includes(name)) continue
    const dst = join(dir, name)
    const { exitCode } = os === 'windows'
      ? await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command',
        'New-Item -ItemType Directory -Force (Split-Path $env:PRISM_DST) | Out-Null; Copy-Item -LiteralPath $env:PRISM_SRC -Destination $env:PRISM_DST -Force'],
      { env: { PRISM_SRC: f.path, PRISM_DST: dst }, timeoutMs: 120000 })
      : await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$PRISM_DST")" && cp -f -- "$PRISM_SRC" "$PRISM_DST"'],
        { env: { PRISM_SRC: f.path, PRISM_DST: dst }, timeoutMs: 120000 })
    if (exitCode !== 0) throw new Error(`could not copy ${f.path}`)
  }
  await removePaths($, os, have.filter(n => !want.has(n)).map(n => join(dir, n)))
  return [...want.keys()].map(n => `prism-assets/${n}`)
}

export { providerFor }

// C6 ---------------------------------------------------------------------------------------------------------------

/** The person's own folder: themes/<id>.json (+ .css, + pictures/videos), rules.json. Kept across mod updates. */
export async function prismHome($: EngineInterface) {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return home ? join(home, '.claude', 'prism-themes') : undefined
}

export type Problem = { file: string; errors: string[]; warnings: string[] }
export type Library = { dir?: string; themes: Theme[]; problems: Problem[]; rules: Rule[]; ruleErrors: string[] }

const isAbsolute = (p: string) => /^[a-zA-Z]:[\\/]|^[\\/]/.test(p)

/** Reads every theme file and the rules; a broken file is reported, never fatal. */
export async function loadLibrary($: EngineInterface, builtins: Theme[]): Promise<Library> {
  const home = await prismHome($)
  const lib: Library = { dir: home, themes: [], problems: [], rules: [], ruleErrors: [] }
  if (!home) return lib
  const dir = join(home, 'themes')
  const drafts = new Map<string, Draft>(builtins.map(t => [t.id, { ...t }]))
  const mine: string[] = []
  if (await $.fs.exists(dir)) {
    for (const e of (await $.fs.list(dir)).filter(x => x.kind === 'file' && x.name.endsWith('.json'))) {
      const problem: Problem = { file: e.name, errors: [], warnings: [] }
      let raw: unknown
      try { raw = JSON.parse(await readText($, join(dir, e.name))) } catch { problem.errors.push('not valid JSON') }
      const parsed = problem.errors.length ? undefined : parseTheme(raw)
      if (parsed) { problem.errors.push(...parsed.errors); problem.warnings.push(...parsed.warnings) }
      const d = parsed?.draft
      if (d && drafts.has(d.id)) problem.errors.push(`id "${d.id}" is taken by ${builtins.some(b => b.id === d.id) ? 'a built-in theme' : 'another file'}`)
      else if (d && `${d.id}.json` !== e.name) problem.warnings.push(`the file is named ${e.name} but its id is "${d.id}"`)
      if (d?.cssFile) {
        const css = await readText($, join(dir, d.cssFile)).catch(() => undefined)
        if (css === undefined) problem.errors.push(`css: ${d.cssFile} not found beside the theme`)
        else if (!safeCss(css)) problem.errors.push(`css: ${d.cssFile} loads from outside the page (@import, url() other than data:, or a backslash escape)`)
        else d.css = css
      }
      if (d?.media && !isAbsolute(d.media.path)) d.media = { ...d.media, path: join(dir, d.media.path) }
      if (d && !problem.errors.length) { drafts.set(d.id, d); mine.push(d.id) }
      if (problem.errors.length || problem.warnings.length) lib.problems.push(problem)
    }
  }
  for (const id of mine) {
    const { theme, errors } = finalize(id, x => drafts.get(x))
    if (theme) lib.themes.push({ ...theme, source: 'user' })
    else lib.problems.push({ file: `${id}.json`, errors, warnings: [] })
  }
  const rulesPath = join(home, 'rules.json')
  if (await $.fs.exists(rulesPath)) {
    try {
      const { rules, errors } = parseRules(JSON.parse(await readText($, rulesPath)))
      lib.rules = rules
      lib.ruleErrors = errors
    } catch {
      lib.ruleErrors = ['rules.json is not valid JSON']
    }
  }
  return lib
}

/** Copies v1 themes (claude-desktop-themes' <id>.json + <id>.css) into the themes folder as schema 2. */
export async function importV1($: EngineInterface, from: string): Promise<string[]> {
  const home = await prismHome($)
  if (!home) return ['No home folder to keep themes in.']
  if (!(await $.fs.exists(from))) return [`Nothing at ${from}`]
  const dir = join(home, 'themes')
  const out: string[] = []
  const files = (await $.fs.list(from)).filter(e => e.kind === 'file')
  for (const e of files.filter(x => x.name.endsWith('.json'))) {
    let raw: unknown
    try { raw = JSON.parse(await readText($, join(from, e.name))) } catch { out.push(`${e.name}: not JSON, skipped`); continue }
    const id = (raw as { id?: unknown })?.id
    const cssName = typeof id === 'string' ? `${id}.css` : ''
    let css = cssName && files.some(f => f.name === cssName) ? convertV1Css(await readText($, join(from, cssName))) : undefined
    const notes: string[] = []
    if (css !== undefined && !safeCss(css)) { notes.push('its stylesheet loads from outside the page and was left out'); css = undefined }
    const { file, notes: more } = fromV1(raw, css !== undefined)
    notes.push(...more)
    if (!file) { out.push(`${e.name}: ${notes.join('; ')}`); continue }
    const target = join(dir, `${String(file.id)}.json`)
    if (await $.fs.exists(target)) { out.push(`${e.name}: ${String(file.id)} already exists, skipped`); continue }
    await $.fs.write(target, JSON.stringify(file, null, 2) + '\n')
    if (css !== undefined) await $.fs.write(join(dir, cssName), css)
    out.push(`${e.name}: imported as ${String(file.id)}${notes.length ? ` (${notes.join('; ')})` : ''}`)
  }
  return out.length ? out : [`No .json themes in ${from}`]
}

/** C8: write our files into the slot found by C1 and record exactly what we changed. */
export async function install($: EngineInterface, d: Discovery, payload: Payload | Record<string, never>): Promise<Outcome> {
  const slot = slotOf(d)
  if (!d.os || !slot || !d.userData) return { ok: false, message: 'Could not find Claude Desktop\'s data folder. Is the app running?' }
  const extensions = join(d.userData, 'extensions')
  const before = await readRecord($, slot)
  const extensionsExisted = before ? before.extensionsExisted : await $.fs.exists(extensions)
  const slotExisted = before ? before.slotExisted : await $.fs.exists(slot)
  const envWasSet = await userEnvIsSet($, d.os)
  const setEnv = before?.setEnv || !envWasSet

  const manifest = await readJson<Manifest>($, join(slot, 'manifest.json'))
  await $.fs.write(join(slot, OUR_JS), await assembleScript($))
  await writePayload($, slot, payload)
  await $.fs.write(join(slot, 'manifest.json'), JSON.stringify(withOurs(manifest, VERSION), null, 2))
  if (!envWasSet && (await setUserEnv($, d.os)) !== 0) {
    return { ok: false, message: 'The extension is copied, but REACT_PROFILE=1 could not be set.' }
  }
  const record: InstallRecord = {
    version: VERSION, installedAt: await $.clock.now(), userData: d.userData, setEnv, slotExisted, extensionsExisted,
  }
  await $.fs.write(join(slot, OUR_RECORD), JSON.stringify(record, null, 2))
  const quit = d.os === 'windows' ? 'also from the system tray' : 'Cmd+Q'
  return { ok: true, message: `Installed. Quit Claude Desktop fully (${quit}) and open it again.` }
}

/** C8: undo what the install record says we did, and leave everything else in the slot alone. */
export async function uninstall($: EngineInterface, d: Discovery): Promise<Outcome> {
  const slot = slotOf(d)
  if (!d.os || !slot || !d.userData) return { ok: false, message: 'Could not find Claude Desktop\'s data folder.' }
  const record = await readRecord($, slot)
  const manifest = await readJson<Manifest>($, join(slot, 'manifest.json'))
  const rest = manifest ? withoutOurs(manifest) : undefined

  let code: number
  if (rest) {
    // another extension shares the slot: keep it, take out only ours
    await $.fs.write(join(slot, 'manifest.json'), JSON.stringify(rest, null, 2))
    code = await removePaths($, d.os, OUR_FILES.map(f => join(slot, f)))
    await removeOurDirs($, d.os, slot)
  } else if (record && !record.slotExisted) {
    code = await removeDir($, d.os, slot, true)
    if (!record.extensionsExisted) await removeDir($, d.os, join(d.userData, 'extensions'), false)
  } else {
    code = await removePaths($, d.os, [...OUR_FILES, 'manifest.json'].map(f => join(slot, f)))
    await removeOurDirs($, d.os, slot)
  }
  if (record?.setEnv && !rest) await clearUserEnv($, d.os)
  return code === 0
    ? { ok: true, message: 'Extension removed. Restart Claude Desktop to finish.' }
    : { ok: false, message: `Some files could not be removed. Check ${slot}` }
}
