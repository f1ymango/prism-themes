/** What the last `$.ui.backdrop` call for a theme with a background answered. */
export type Tier1 = { isDrawn: boolean; reason?: string }

/** The extension's state, inferred by the mod (the page cannot report back). */
export type Tier2 = { state: 'unsupported' | 'missing' | 'restart' | 'active'; slot?: string }

/** Where Claude Desktop's data was found, and why. */
export type Found = { os?: string; userData?: string; source?: string; appStartedMs?: number; evidence: string[] }

/** The custom background, as the strip shows it. */
export type Custom = {
  provider: 'image' | 'slideshow' | 'svg' | 'video'
  count: number
  name: string
  interval: number
  fit: 'cover' | 'contain'
  dim: number
}

/** The person's own themes, as the strip shows them. */
export type LibraryInfo = {
  dir: string
  themes: { id: string; name: string }[]
  problems: number
  warnings: number
  ruleUse?: string
}

declare module 'claude-code' {
  interface PluginState {
    'prism-themes': {
      isOpen: boolean
      isBusy: boolean
      current: string
      tier1: Tier1 | null
      tier2: Tier2 | null
      found: Found | null
      custom: Custom | null
      panels: 'glass' | 'clear' | 'solid'
      libraryInfo: LibraryInfo | null
    }
  }
}
