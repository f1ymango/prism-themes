// C1: where Claude Desktop keeps its user data, and so where it loads extensions from.
// Pure functions only; host.ts gathers the inputs.

export const SLOT_ID = 'fmkadmapgofadopljbjfkapdkoienihi' // the React DevTools slot, loaded when REACT_PROFILE=1

export type OS = 'windows' | 'macos'
export type UserDataSource = 'process' | 'marker' | 'classic' | 'msix' | 'macos'
export type Discovery = {
  os?: OS
  userData?: string
  source?: UserDataSource
  appStartedMs?: number
  evidence: string[]
}

/** Joins with the separator the base already uses: Windows paths hold a backslash, macOS ones never do. */
export const join = (base: string, ...parts: string[]) => {
  const sep = base.includes('\\') ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

export type Proc = { startedMs: number; cmd: string }

/** Parses `<startMs>|<command line>` lines, as the Windows process query prints them. */
export const parseWinProcs = (stdout: string): Proc[] =>
  stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean).flatMap(l => {
    const i = l.indexOf('|')
    const ms = Number(l.slice(0, i))
    return i > 0 && Number.isFinite(ms) && ms > 0 ? [{ startedMs: ms, cmd: l.slice(i + 1) }] : []
  })

/** macOS `ps -o etime`: `[[dd-]hh:]mm:ss` → seconds. */
export const etimeSeconds = (s: string): number | undefined => {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!m) return undefined
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
}

/** Parses `ps -axo etime=,args=` lines for Claude Desktop's processes. */
export const parseMacProcs = (stdout: string, nowMs: number): Proc[] =>
  stdout.split('\n').flatMap(l => {
    const m = l.trim().match(/^(\S+)\s+(.*)$/)
    if (!m || !m[2]!.includes('/Claude.app/Contents/')) return []
    const secs = etimeSeconds(m[1]!)
    return secs === undefined ? [] : [{ startedMs: nowMs - secs * 1000, cmd: m[2]! }]
  })

export const userDataOf = (cmd: string): string | undefined => {
  const m = cmd.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/)
  return m ? (m[1] ?? m[2]) : undefined
}

/** The app's main process carries no `--type=`; its helpers do. */
export const isMainProcess = (cmd: string) => !/\s--type=/.test(cmd)

export const fromProcesses = (procs: Proc[]) => {
  const dirs = [...new Set(procs.map(p => userDataOf(p.cmd)).filter((d): d is string => !!d))]
  const mains = procs.filter(p => isMainProcess(p.cmd))
  const pool = mains.length ? mains : procs
  return { dirs, appStartedMs: pool.length ? Math.min(...pool.map(p => p.startedMs)) : undefined }
}

/** `%APPDATA%\Claude` holds `.user-data-left.<name>` when the app moved its data to `Claude-Data\<name>`. */
export const markerTarget = (names: string[]): string | undefined => {
  const n = names.find(x => x.startsWith('.user-data-left.'))
  const target = n?.slice('.user-data-left.'.length)
  return target && /^[\w.-]+$/.test(target) ? target : undefined
}

export type Candidate = { path: string; source: UserDataSource; live: boolean; mtimeMs: number }

const RANK: Record<UserDataSource, number> = { process: 0, marker: 1, classic: 2, msix: 2, macos: 2 }

/** The best live candidate: a running process's own word first, then the move marker, then the newest data. */
export const pick = (cands: Candidate[]): Candidate | undefined =>
  cands.filter(c => c.live).sort((a, b) => RANK[a.source] - RANK[b.source] || b.mtimeMs - a.mtimeMs)[0]
