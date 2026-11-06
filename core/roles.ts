// C4: the one place that knows the app's DOM. Themes and rules name roles; a role lists selectors, most stable first.
// Checked against desktop 4.16336 (html[data-version=1.0.0], FINDINGS.md). When the app changes, fix it here.

export type RoleRule = { id: string; roles: string[]; css: string }

export const ROLES: Record<string, string[]> = {
  root: ['.dframe-root'],
  sidebar: ['.dframe-sidebar'],
  sidebarBody: ['.dframe-sidebar-body'],
  peek: ['.dframe-chrome-peek-band'],
  content: ['main.dframe-content', 'main'],
  tiles: ['.tiles-shell'],
  // the right-hand panel (environment, context, outputs): the tile shell that holds no chat
  sidePanel: ['.tiles-shell:not(:has(.epitaxy-chat-panel))'],
  grid: ['.root > .grid.bg-surface-1'],
  composer: ['[data-cds=ChatComposer] > .bg-surface-3', '[data-cds=ChatComposer] > div'],
  transcript: ['.epitaxy-transcript-typography'],
  startCard: ['[data-testid=epitaxy-start-card]'],
  codeBlock: ['diffs-container'],
}

/** Roles whose absence means a broken map rather than a closed panel. */
export const REQUIRED_ROLES = ['sidebar', 'composer']

/** Surfaces the colour variables cannot reach. On while a theme with a palette is on. */
export const BASE_RULES: RoleRule[] = [
  { id: 'sidebar', roles: ['root', 'sidebar'], css: '@{root}:not([data-collapsed]) @{sidebar} { background-color: var(--prism-sidebar) !important; }' },
  { id: 'sidebar-collapsed', roles: ['root', 'sidebarBody'], css: '@{root}[data-collapsed] @{sidebarBody} { --df-web-sidebar-bg: var(--prism-sidebar) !important; }' },
  { id: 'peek', roles: ['peek'], css: '@{peek} { background-color: var(--prism-sidebar) !important; }' },
  {
    id: 'code', roles: ['codeBlock'],
    css: '@{codeBlock} { --diffs-light-bg: var(--cds-surface-2) !important; --diffs-dark-bg: var(--cds-surface-2) !important; ' +
      '--diffs-light: var(--cds-text-primary) !important; --diffs-dark: var(--cds-text-primary) !important; }',
  },
]

/** A background the page draws. Every rule waits on html[data-tfc-wall], which wallReady() grants. */
export const WALL_RULES: RoleRule[] = [
  {
    id: 'wall', roles: [],
    css: 'html[data-tfc-wall] { background: var(--prism-wall) fixed !important; }\n' +
      'html[data-tfc-wall] body { background: transparent !important; }\n' +
      'html[data-tfc-wall] * { --cds-page-bg: transparent !important; --epitaxy-transcript-surface: transparent !important; }',
  },
  { id: 'wall-content', roles: ['content'], css: 'html[data-tfc-wall] @{content} { background: transparent !important; }' },
  { id: 'wall-tiles', roles: ['tiles'], css: 'html[data-tfc-wall] @{tiles} { background: transparent !important; }' },
  { id: 'wall-grid', roles: ['grid'], css: 'html[data-tfc-wall] @{grid} { background: transparent !important; }' },
  { id: 'glass', roles: ['composer'], css: 'html[data-tfc-wall] @{composer} { background: var(--prism-glass) !important; backdrop-filter: blur(10px); }' },
  // Side panels over a background. The page marks them (data-tfc-panel) and the big solid layers inside them
  // (data-tfc-clear) itself, by size and colour rather than by class name, so a renamed inner class changes nothing.
  {
    id: 'panels', roles: [],
    css: 'html[data-tfc-wall] [data-tfc-clear] { background-color: transparent !important; background-image: none !important; ' +
      '--df-web-sidebar-bg: transparent !important; }\n' +
      'html[data-tfc-wall][data-tfc-panels=glass] [data-tfc-panel] { background: var(--prism-glass) !important; ' +
      'backdrop-filter: blur(14px) saturate(1.2); }\n' +
      'html[data-tfc-wall][data-tfc-panels=clear] [data-tfc-panel] { background: transparent !important; }\n' +
      'html[data-tfc-wall][data-tfc-panels] [data-tfc-panel] { text-shadow: 0 0 3px var(--prism-halo), 0 0 8px var(--prism-halo); }',
  },
  // all text in the content area, the faint lines too (notices, command output), not only the transcript's prose
  { id: 'halo', roles: ['content'], css: 'html[data-tfc-wall] @{content} { text-shadow: 0 0 3px var(--prism-halo), 0 0 8px var(--prism-halo); }' },
]

/** C5: reactions to what Claude is doing, from the session's own event file. */
export const REACTION_RULES: RoleRule[] = [
  {
    id: 'tool-glow', roles: ['composer'],
    css: 'html[data-tfc-event=tool] @{composer} { box-shadow: 0 0 0 1.5px var(--cds-text-accent), ' +
      '0 0 22px color-mix(in srgb, var(--cds-text-accent) 45%, transparent) !important; transition: box-shadow .3s; }',
  },
  {
    id: 'error-shake', roles: ['composer'],
    css: '@keyframes prism-shake { 0%, 100% { translate: 0; } 25% { translate: -5px; } 75% { translate: 5px; } }\n' +
      '@media (prefers-reduced-motion: no-preference) { html[data-tfc-event=error] @{composer} { animation: prism-shake .35s 2; } }\n' +
      'html[data-tfc-event=error] @{composer} { box-shadow: 0 0 0 1.5px #e5484d !important; }',
  },
  {
    id: 'waiting', roles: [],
    css: 'html[data-tfc-state=waiting] body::after { content: ""; position: fixed; inset: 0; pointer-events: none; ' +
      'z-index: 2147483645; box-shadow: inset 0 0 70px color-mix(in srgb, var(--cds-text-accent) 40%, transparent); }',
  },
]

/** Light themes: the native window buttons keep their dark-mode (light) glyphs, so give them a dark plate. */
// (body::before: imported v1 stylesheets use html::before/::after and body::after for their own effects)
export const TITLEBAR_CSS = 'html[data-tfc-mode=light] body::before { content: ""; position: fixed; top: 0; right: 0; ' +
  'left: calc(env(titlebar-area-x, 0px) + env(titlebar-area-width, calc(100vw - 150px))); ' +
  'height: env(titlebar-area-height, 36px); background: var(--prism-controls); border-bottom-left-radius: 8px; ' +
  'pointer-events: none; z-index: 2147483646; }'
