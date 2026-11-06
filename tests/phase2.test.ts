import { expect, test } from 'claude-code/testing'

import { compileRules, resolveRoles, wallReady } from '../extension/compile.js'
import { assetName, providerFor, refusal, sniff } from '../core/media'
import type { Checked } from '../core/media'
import { resolve, safeCss } from '../core/resolve'
import type { Payload } from '../core/resolve'
import { BASE_RULES, REACTION_RULES, ROLES, WALL_RULES } from '../core/roles'
import { THEMES } from '../core/themes'

// A page as the content script sees it: which selectors match right now.
const page = (present: string[]) => (s: string) => present.includes(s)
const TODAY = ['.dframe-root', '.dframe-sidebar', '.dframe-chrome-peek-band', 'main.dframe-content', '.tiles-shell',
  '.root > .grid.bg-surface-1', '[data-cds=ChatComposer] > .bg-surface-3', '.epitaxy-transcript-typography']
const ALL = [...BASE_RULES, ...WALL_RULES, ...REACTION_RULES]

test('C4: on today\'s page every rule but the absent ones applies', async () => {
  const r = resolveRoles(ROLES, page(TODAY))
  const { css, dropped } = compileRules(ALL, r)
  expect(dropped.sort()).toEqual(['code', 'sidebar-collapsed']) // no code block, sidebar open: absent, not broken
  expect(css.includes('@{')).toBe(false)
  expect(css.includes('.dframe-root:not([data-collapsed]) .dframe-sidebar')).toBe(true)
  expect(safeCss(css)).toBe(true)
  expect(wallReady(r)).toBe(true)
})

test('C4: a renamed selector turns off exactly its own role\'s rules', async () => {
  const renamed = TODAY.filter(s => s !== '.tiles-shell')
  const { dropped } = compileRules(ALL, resolveRoles(ROLES, page(renamed)))
  expect(dropped.sort()).toEqual(['code', 'sidebar-collapsed', 'wall-tiles'])
})

test('C4: a role falls back to its next selector, and no readable panels means no page background', async () => {
  const older = TODAY.filter(s => s !== '[data-cds=ChatComposer] > .bg-surface-3').concat('[data-cds=ChatComposer] > div')
  const r = resolveRoles(ROLES, page(older))
  expect(r.composer).toBe('[data-cds=ChatComposer] > div')
  expect(compileRules(ALL, r).css.includes('[data-cds=ChatComposer] > div { background: var(--prism-glass)')).toBe(true)
  expect(wallReady(resolveRoles(ROLES, page(['.dframe-sidebar'])))).toBe(false)
  expect(resolveRoles({ x: ['::bad('] }, () => { throw new Error('syntax') }).x).toBe(null) // a bad selector is just absent
})

test('C4: role selectors stay single selectors (a comma would break the rules they go into)', async () => {
  for (const sels of Object.values(ROLES)) for (const s of sels) expect(s.includes(',')).toBe(false)
  for (const rule of ALL) for (const n of rule.css.match(/@\{(\w+)\}/g) ?? []) expect(rule.roles.includes(n.slice(2, -1))).toBe(true)
})

test('C7: files are judged by their bytes', async () => {
  expect(sniff('ffd8ffe000104a46')).toBe('jpeg')
  expect(sniff('89504e470d0a1a0a0000')).toBe('png')
  expect(sniff('474946383961')).toBe('gif')
  expect(sniff('52494646aaaaaaaa57454250')).toBe('webp')
  expect(sniff('1a45dfa39f4286')).toBe('webm')
  expect(sniff('0000001c66747970' + '69736f6d')).toBe('mp4')
  expect(sniff('0000001c66747970' + '61766966')).toBe('avif')
  expect(sniff('0000001466747970' + '71742020')).toBe(undefined) // QuickTime .mov
  const hex = (s: string) => [...s].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  expect(sniff('efbbbf' + hex('  <?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg">'))).toBe('svg')
  expect(sniff(hex('<html><body>no</body></html>'))).toBe(undefined)
  expect(sniff(hex('MZ this is an exe'))).toBe(undefined)
  expect(refusal('C:\\a\\big.mp4', 'mp4', 80 * 1024 * 1024)).toBe('big.mp4 is 80 MB; the limit for a video is 50 MB')
  expect(refusal('x.exe', undefined, 10)?.startsWith('x.exe is not')).toBe(true)
  expect(refusal('ok.png', 'png', 1000)).toBe(undefined)
})

const f = (path: string, kind: Checked['kind']): Checked => ({ path, kind, size: 10, mtimeMs: 1 })

test('C3: providers and asset names', async () => {
  expect(providerFor([f('a.mp4', 'mp4')])).toBe('video')
  expect(providerFor([f('a.svg', 'svg')])).toBe('svg')
  expect(providerFor([f('a.jpg', 'jpeg')])).toBe('image')
  expect(providerFor([f('a.jpg', 'jpeg'), f('b.png', 'png')])).toBe('slideshow')
  expect(providerFor([f('a.jpg', 'jpeg'), f('b.mp4', 'mp4')])).toBe(undefined)
  expect(providerFor([])).toBe(undefined)
  const name = assetName(f('C:\\pics\\a.jpg', 'jpeg'))
  expect(/^bg-[0-9a-f]{8}\.jpg$/.test(name)).toBe(true)
  expect(assetName({ ...f('C:\\pics\\a.jpg', 'jpeg'), mtimeMs: 2 })).not.toBe(name) // a changed file is copied again
})

test('C2/C3: payloads — gradient by the page, media over any theme, light themes guard the window buttons', async () => {
  const dusk = THEMES.find(t => t.id === 'dusk')!
  const parchment = THEMES.find(t => t.id === 'parchment')!
  const byPage = resolve(dusk, { backgroundByPage: true }) as Payload
  expect(byPage.vars['prism-wall']).toBe('linear-gradient(160deg, #1b1430, #3a2350, #7a3d5c, #c0645a)')
  expect(byPage.rules.some(r => r.id === 'wall')).toBe(true)
  const byBackdrop = resolve(dusk, { backgroundByPage: false }) as Payload
  expect(byBackdrop.rules.some(r => r.id === 'wall')).toBe(false)
  const media = { provider: 'video' as const, files: ['prism-assets/bg-0000abcd.mp4'], interval: 60, fit: 'cover' as const, dim: 0.3 }
  const claudeWithVideo = resolve(undefined, { backgroundByPage: false, media }) as Payload
  expect(claudeWithVideo.id).toBe('claude')
  expect(claudeWithVideo.background).toEqual(media)
  expect(claudeWithVideo.rules.some(r => r.id === 'sidebar')).toBe(false) // no palette: the app's own colours stay
  expect(resolve(undefined, { backgroundByPage: false })).toEqual({})
  const light = resolve(parchment, { backgroundByPage: false }) as Payload
  expect(light.css.includes('html[data-tfc-mode=light] body::before')).toBe(true)
  expect(light.vars['prism-controls']).toBe('#3a2f22')
  expect((resolve(dusk, { backgroundByPage: true }) as Payload).css).toBe('')
  // side panels follow a background only, glass unless set
  expect(claudeWithVideo.panels).toBe('glass')
  expect((resolve(undefined, { backgroundByPage: false, media, panels: 'clear' }) as Payload).panels).toBe('clear')
  expect(light.panels).toBe(undefined)
  expect(byPage.rules.some(r => r.id === 'panels')).toBe(true)
  for (const p of [byPage, light, claudeWithVideo]) {
    expect(safeCss(p.css)).toBe(true)
    expect(JSON.stringify(p).includes('data-theme=')).toBe(false) // never the app's own attribute
    for (const v of Object.values(p.vars)) expect(/[;{}<>]/.test(v)).toBe(false)
  }
})
