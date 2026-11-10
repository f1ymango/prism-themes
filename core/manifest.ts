// C8: our entries in the slot's manifest. The slot is React DevTools' own and other mods may share it,
// so we add and take out only what is ours. Adapted from 0toshigami/claude-desktop-themes (MIT).

export const OUR_JS = 'prism.js'
export const OUR_PAYLOAD = 'prism-theme.json'
export const OUR_RECORD = 'prism-install.json'
/** What the mod reports when a part of Prism stops working (core/health.ts), for the page's notice. */
export const OUR_HEALTH = 'prism-health.json'
export const OUR_FILES = [OUR_JS, OUR_PAYLOAD, OUR_RECORD, OUR_HEALTH]
/** Folders of ours in the slot: per-session event files (C5) and copied backgrounds (C3). */
export const OUR_DIRS = ['events', 'prism-assets']
const OUR_WAR = [OUR_PAYLOAD, OUR_HEALTH, 'events/*.json', 'prism-assets/*']

type Script = { matches?: string[]; js?: string[]; run_at?: string; [k: string]: unknown }
type Resources = { resources?: string[]; matches?: string[]; [k: string]: unknown }
export type Manifest = {
  manifest_version?: number
  name?: string
  version?: string
  content_scripts?: Script[]
  web_accessible_resources?: Resources[]
  [k: string]: unknown
}

// Only claude.ai, top frame: the baseline matched <all_urls>.
const OUR_SCRIPT: Script = { matches: ['https://claude.ai/*'], js: [OUR_JS], run_at: 'document_idle' }
const OUR_RESOURCES: Resources = { resources: OUR_WAR, matches: ['https://claude.ai/*'] }
const notOurs = (r: string) => !OUR_WAR.includes(r)

export const freshManifest = (version: string): Manifest => ({
  manifest_version: 3,
  name: 'Prism Themes',
  version,
  description: 'Applies the theme picked in the Prism Themes mod to Claude Desktop.',
  content_scripts: [OUR_SCRIPT],
  web_accessible_resources: [OUR_RESOURCES],
})

const isOurs = (s: Script) => !!s.js?.includes(OUR_JS)

/** The manifest with our entries in (replacing older copies of them); a fresh one when there was none. */
export const withOurs = (m: Manifest | undefined, version: string): Manifest => {
  if (!m) return freshManifest(version)
  const scripts = [...(m.content_scripts ?? []).filter(s => !isOurs(s)), OUR_SCRIPT]
  const war = [
    ...(m.web_accessible_resources ?? [])
      .map(w => ({ ...w, resources: w.resources?.filter(notOurs) }))
      .filter(w => w.resources?.length),
    OUR_RESOURCES,
  ]
  return { ...m, content_scripts: scripts, web_accessible_resources: war }
}

/** The manifest without our entries; undefined when nothing but ours was in it. */
export const withoutOurs = (m: Manifest): Manifest | undefined => {
  const scripts = (m.content_scripts ?? []).filter(s => !isOurs(s))
  if (!scripts.length) return undefined
  const war = (m.web_accessible_resources ?? [])
    .map(w => ({ ...w, resources: w.resources?.filter(notOurs) }))
    .filter(w => w.resources?.length)
  return { ...m, content_scripts: scripts, web_accessible_resources: war }
}

export const hasOurs = (m: Manifest | undefined) => !!m?.content_scripts?.some(isOurs)

/** What we did at install, so uninstall undoes exactly that. */
export type InstallRecord = {
  version: string
  installedAt: number
  userData: string
  /** true only when REACT_PROFILE was not 1 before and we set it */
  setEnv: boolean
  /** whether the slot folder existed before we wrote to it */
  slotExisted: boolean
  /** whether its parent `extensions` folder existed before */
  extensionsExisted: boolean
}

export const parseRecord = (text: string): InstallRecord | undefined => {
  try {
    const r = JSON.parse(text)
    return r && typeof r.installedAt === 'number' && typeof r.setEnv === 'boolean' ? r : undefined
  } catch {
    return undefined
  }
}
