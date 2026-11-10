// Breakage alerts. Claude Code and Claude Desktop update often, and an update can take away an API or a page
// element Prism relies on. The theme already on screen usually stays (the page keeps the last payload), so the
// break is only noticed when something new fails. Each part of Prism runs guarded: a failure is recorded under
// the part's name instead of stopping the rest, and is shown in a toast, the strip, /prism doctor and on the page.
// Like the Codex port's build check, Prism remembers the Claude Code version it last ran on cleanly, so it can say
// "this started with the update" rather than only "something failed".

/** error: something the person asked for does not happen. note: a fallback covers it. */
export type HealthLevel = 'error' | 'note'
export type HealthProblem = { part: string; level: HealthLevel; detail: string }

/** What the page reads from health.json in the extension's folder. */
export type HealthFile = { v: 1; at: number; version?: string; lastGood?: string; problems: (HealthProblem & { name: string })[] }

/** The parts of Prism, as people read them. */
export const PARTS: Record<string, string> = {
  commands: 'the /prism command',
  version: 'reading the Claude Code version',
  discover: 'finding Claude Desktop',
  extension: 'updating the extension',
  library: 'reading your themes',
  apply: 'applying and switching themes',
  backdrop: 'the official backdrop',
  events: 'reacting to what Claude does',
  install: 'installing or removing the extension',
  settings: 'changing settings',
}

export const partName = (part: string) => PARTS[part] ?? part

/** Error text without the noise a thrown value carries. */
export function describeError(err: unknown): string {
  const text = err instanceof Error ? `${err.name === 'Error' ? '' : `${err.name}: `}${err.message}` : String(err)
  return text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error'
}

/** Records a problem; the same part keeps only its latest. True when anything changed. */
export function record(list: HealthProblem[], p: HealthProblem): boolean {
  const i = list.findIndex(x => x.part === p.part)
  if (i >= 0 && list[i]!.detail === p.detail && list[i]!.level === p.level) return false
  if (i >= 0) list[i] = p
  else list.push(p)
  return true
}

/** Clears a part once it works again. True when anything changed. */
export function settle(list: HealthProblem[], part: string): boolean {
  const i = list.findIndex(x => x.part === part)
  if (i < 0) return false
  list.splice(i, 1)
  return true
}

export const errorsOf = (list: HealthProblem[]) => list.filter(p => p.level === 'error')

/** The toast after a start with problems, or undefined when nothing is broken. */
export function alertText(list: HealthProblem[], version?: string, lastGood?: string): string | undefined {
  const errors = errorsOf(list)
  if (!errors.length) return undefined
  const parts = errors.map(p => partName(p.part)).join(', ')
  const updated = version && lastGood && version !== lastGood ? ` since Claude Code updated (${lastGood} → ${version})` : ''
  return `Prism needs a fix${updated}: ${parts} stopped working. The theme on screen may stay, but changes won't apply. ` +
    'Run /prism doctor for details.'
}

/** One line for the strip, or undefined. */
export function stripText(list: HealthProblem[]): string | undefined {
  const errors = errorsOf(list)
  if (!errors.length) return undefined
  return `⚠ Not working: ${errors.map(p => partName(p.part)).join(', ')}. /prism doctor says why.`
}

/** The Health section of /prism doctor. */
export function doctorLines(list: HealthProblem[], version?: string, lastGood?: string): string[] {
  const lines = [
    `  Claude Code: ${version ?? 'unknown'}${lastGood ? ` (last ran with no errors on ${lastGood})` : ''}`,
  ]
  if (!list.length) lines.push('  everything Prism tried has worked')
  for (const p of list) lines.push(`  ${p.level === 'error' ? '✗' : '!'} ${partName(p.part)}: ${p.detail}`)
  if (errorsOf(list).length) {
    lines.push('  An update to Claude Code or Claude Desktop is the usual cause. Check for a newer Prism, or report these lines.')
  }
  return lines
}

/** What the page is told: errors only, in plain words. */
export function healthFile(list: HealthProblem[], at: number, version?: string, lastGood?: string): HealthFile {
  return {
    v: 1, at, version, lastGood,
    problems: errorsOf(list).map(p => ({ ...p, name: partName(p.part), detail: p.detail.slice(0, 200) })),
  }
}
