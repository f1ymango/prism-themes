import { expect, test } from 'claude-code/testing'

import { contrast, rgb, varsOf } from '../core/palette'
import { resolve, safeCss } from '../core/resolve'
import type { Payload, Theme } from '../core/resolve'
import { convertV1Css, finalize, fromV1, parseRules, parseTheme, pickRule, projectMatches, timeMatches } from '../core/schema'
import type { Draft } from '../core/schema'
import { THEMES } from '../core/themes'

const ok = (raw: unknown) => {
  const p = parseTheme(raw)
  expect(p.errors).toEqual([])
  return p.draft!
}

test('C6: a full schema-2 theme reads layer by layer', async () => {
  const d = ok({
    schema: 2, id: 'koi-evening', name: 'Koi Evening', tagline: 'Pond at dusk',
    palette: { light: { bg: '#f4efe6', text: '#2b2a28', accent: '#c4551f' }, dark: { bg: '#11332d', text: '#e4f2ea', accent: '#ef8a4a' } },
    typography: { font: "Georgia, 'Times New Roman', serif" },
    shape: { radius: 10 },
    background: { file: 'koi.mp4', dim: 0.3 },
    panels: 'clear',
    status: { idle: '◌', tool: '◌ {tool}…', error: '◌ {tool} failed', done: '◎ done' },
    tokens: { 'cds-radius-composer': '22px' },
    css: 'koi-evening.css',
  })
  expect(d.variants?.light.bg).toBe('#f4efe6')
  expect(d.radius).toEqual({ base: 10, composer: 20 })
  expect(d.media).toEqual({ path: 'koi.mp4', fit: 'cover', dim: 0.3, interval: 60 })
  expect(d.cssFile).toBe('koi-evening.css')
})

test('C6: errors name the field and say what is wanted', async () => {
  const p = parseTheme({ schema: 2, id: 'Bad Id', palette: { bg: 'red', text: '#fff', accent: '#000000' }, panels: 'frosted', shape: { radius: 99 } })
  expect(p.draft).toBe(undefined)
  expect(p.errors).toEqual([
    'id: lowercase letters, digits and dashes, starting with a letter (2–41)',
    'palette: bg must be a #rrggbb colour; text must be a #rrggbb colour',
    'shape: { radius, composerRadius? } in pixels, 0–40',
    'panels: glass, clear or solid',
  ])
  expect(parseTheme({ id: 'old' }).errors[0]).toBe('schema: must be 2 (a v1 theme? use /prism import <folder>)')
  expect(parseTheme('nope').errors).toEqual(['the file is not a JSON object'])
  const warned = parseTheme({ schema: 2, id: 'tok', palette: { bg: '#000000', text: '#ffffff', accent: '#ff0000' }, tokens: { 'x': 'url(https://e.vil)', 'ok-name': '4px' } })
  expect(warned.draft?.tokens).toEqual({ 'ok-name': '4px' })
  expect(warned.warnings.length).toBe(2)
})

test('C6: extends — the child overrides only its own layers; loops and gaps are errors', async () => {
  const drafts = new Map<string, Draft>(THEMES.map(t => [t.id, { ...t }]))
  drafts.set('dusk-serif', ok({ schema: 2, id: 'dusk-serif', name: 'Dusk Serif', extends: 'dusk', typography: { font: 'Georgia, serif' } }))
  drafts.set('dusk-video', ok({ schema: 2, id: 'dusk-video', extends: 'dusk-serif', background: { file: 'C:\\v\\rain.mp4' } }))
  const lookup = (id: string) => drafts.get(id)
  const serif = finalize('dusk-serif', lookup).theme!
  expect(serif.palette.bg).toBe('#241c2e') // from dusk
  expect(serif.font).toBe('Georgia, serif') // its own
  expect(serif.background?.kind).toBe('gradient') // inherited
  const video = finalize('dusk-video', lookup).theme!
  expect(video.background).toBe(undefined) // a file replaces the gradient
  expect(video.media?.path).toBe('C:\\v\\rain.mp4')
  expect(video.name).toBe('Dusk Serif') // no name of its own: the parent's
  drafts.set('aa', ok({ schema: 2, id: 'aa', extends: 'bb' }))
  drafts.set('bb', ok({ schema: 2, id: 'bb', extends: 'aa' }))
  expect(finalize('aa', lookup).errors).toEqual(['extends: a loop (aa → bb → aa)'])
  drafts.set('orphan', ok({ schema: 2, id: 'orphan', extends: 'nowhere' }))
  expect(finalize('orphan', lookup).errors).toEqual(['extends: no theme "nowhere"'])
  drafts.set('bare', ok({ schema: 2, id: 'bare' }))
  expect(finalize('bare', lookup).errors).toEqual(['palette: none (give one, or extend a theme that has one)'])
})

test('C6: light and dark variants reach the page as two sets, and no mode is forced', async () => {
  const d = ok({ schema: 2, id: 'duo', palette: { light: { bg: '#ffffff', text: '#222222', accent: '#0066cc' }, dark: { bg: '#101418', text: '#e8eef4', accent: '#4aa3ff' } } })
  const theme = finalize('duo', () => d).theme as Theme
  const p = resolve(theme, { backgroundByPage: false }) as Payload
  expect(p.mode).toBe(undefined)
  expect(p.variants?.light['cds-text-primary']).toBe('#222222')
  expect(p.variants?.dark['cds-text-primary']).toBe('#e8eef4')
  expect(p.variants?.light['prism-controls']).toBe('#222222')
  expect(p.css.includes('data-tfc-mode=light')).toBe(true) // the window-button plate waits on the light variant
})

test('C6: a theme\'s own stylesheet, tokens and panels reach the payload; your panels choice wins', async () => {
  const t: Theme = { ...THEMES[0]!, css: 'html[data-tfc-event=tool] body { outline: 1px solid red; }', tokens: { 'cds-radius': '2px' }, panels: 'clear' }
  const media = { provider: 'image' as const, files: ['prism-assets/bg-00000001.jpg'], interval: 60, fit: 'cover' as const, dim: 0.2 }
  const p = resolve(t, { backgroundByPage: true, media }) as Payload
  expect(p.css.includes('outline: 1px solid red')).toBe(true)
  expect(p.vars['cds-radius']).toBe('2px')
  expect(p.panels).toBe('clear')
  expect((resolve(t, { backgroundByPage: true, media, panels: 'glass' }) as Payload).panels).toBe('glass')
})

test('palettes: secondary and muted text keep 4.5:1 against the background, for every built-in theme', async () => {
  const rain = { bg: '#161d2b', text: '#eeeae4', accent: '#f0b35e' } // its 55% mix alone was 3.87:1
  for (const p of [rain, ...THEMES.map(t => t.palette)]) {
    const v = varsOf(p)
    for (const k of ['cds-text-secondary', 'cds-text-muted']) expect(contrast(rgb(v[k]!), rgb(p.bg)) >= 4.5).toBe(true)
  }
})

test('C6: rules — projects by folder pattern, times across midnight, first match wins', async () => {
  expect(projectMatches('C:/Projects/my-app*', 'C:\\Projects\\my-app-playground\\src')).toBe(true)
  expect(projectMatches('C:/Projects/my-app', 'C:\\Projects\\my-app')).toBe(true)
  expect(projectMatches('C:/Projects/my-app', 'C:\\Projects\\my-app2')).toBe(false)
  expect(projectMatches('c:\\projects\\Notes-App', 'C:\\Projects\\notes-app\\x')).toBe(true)
  expect(timeMatches('22:00-06:00', 23 * 60)).toBe(true)
  expect(timeMatches('22:00-06:00', 5 * 60 + 59)).toBe(true)
  expect(timeMatches('22:00-06:00', 12 * 60)).toBe(false)
  expect(timeMatches('09:00-17:30', 17 * 60 + 30)).toBe(false)
  const { rules, errors } = parseRules([
    { when: { project: 'C:/Projects/my-app*', time: '19:00-07:00' }, use: 'harbor' },
    { when: { project: 'C:/Projects/my-app*' }, use: 'parchment' },
    { when: { time: '25:00-01:00' }, use: 'dusk' },
    { use: 'claude' },
  ])
  expect(errors).toEqual(['rules[2].when.time: "HH:MM-HH:MM", 24-hour'])
  expect(pickRule(rules, { cwd: 'C:\\Projects\\my-app', minutes: 20 * 60 })?.use).toBe('harbor')
  expect(pickRule(rules, { cwd: 'C:\\Projects\\my-app', minutes: 10 * 60 })?.use).toBe('parchment')
  expect(pickRule(rules, { cwd: 'C:\\Projects\\notes-app', minutes: 10 * 60 })?.use).toBe('claude')
  expect(parseRules({}).errors.length).toBe(1)
})

// Two v1 shapes from claude-desktop-themes: a colour theme, and a live-wallpaper one (live() in its hooks/themes.ts)
const SAKURA_V1 = {
  id: 'sakura', name: 'Sakura', tagline: 'Falling petals, round corners, a gentle bounce',
  bg: '#fff4f6', text: '#4b2a35', accent: '#e0567f',
  vars: { 'cds-radius': '14px', 'cds-radius-composer': '24px', 'cds-panel-radius': '22px', 'cds-dur-base': '.3s' },
  status: { idle: '🌸', tool: '🌸 {tool}…', error: '🥀 {tool} failed', done: '🌸 done' }, deco: '<g/>',
}
const MOONLIT_V1 = {
  id: 'moonlit', name: 'Moonlit', tagline: 'A crescent moon', bg: '#0d1530', text: '#dbe2f5', accent: '#d9c98f', wallpaper: 'moonlit',
  vars: { 'cds-radius': '8px', 'cds-radius-composer': '16px', 'wall-sky': 'radial-gradient(#1a2a5e, #0d1530)', 'wall-greet': '"hi"' },
}

test('C6: v1 themes import as schema 2, saying what could not come along', async () => {
  const s = fromV1(SAKURA_V1, true)
  expect(s.file).toEqual({
    schema: 2, id: 'sakura', name: 'Sakura', tagline: 'Falling petals, round corners, a gentle bounce',
    palette: { bg: '#fff4f6', text: '#4b2a35', accent: '#e0567f' },
    status: SAKURA_V1.status,
    shape: { radius: 14, composerRadius: 24 },
    tokens: { 'cds-panel-radius': '22px', 'cds-dur-base': '.3s' },
    css: 'sakura.css',
  })
  expect(s.notes).toEqual(['its picker decoration (deco) is not used'])
  expect(parseTheme(s.file).errors).toEqual([]) // what the importer writes, the reader accepts
  const m = fromV1(MOONLIT_V1, false)
  expect(m.notes).toEqual(['its wallpaper settings (wall-*) are not carried over',
    'its live ASCII wallpaper "moonlit" is not supported yet; the colours come along'])
  expect((m.file as { tokens?: unknown }).tokens).toBe(undefined)
  expect(parseTheme(m.file).errors).toEqual([])
  expect(fromV1({ id: 'x' }, false).file).toBe(undefined)
  const css = convertV1Css('html[data-theme-event=tool]::before { opacity: 1 } html[data-theme-state=waiting] body::after {}')
  expect(css).toBe('html[data-tfc-event=tool]::before { opacity: 1 } html[data-tfc-state=waiting] body::after {}')
  expect(safeCss(css)).toBe(true)
})
