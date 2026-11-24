import { expect, test } from 'claude-code/testing'

import { officialPalette } from '../core/colors'
import { glassFor, isOlderEngine, sceneName, sceneOf, schemeFor } from '../core/official'
import { resolve } from '../core/resolve'
import type { Payload } from '../core/resolve'
import { makeColors } from '../hooks/make-colors.js'
import { THEMES } from '../core/themes'

const dusk = THEMES.find(t => t.id === 'dusk')!

test('official route: Prism panel settings become the desktop app\'s own panel glass', async () => {
  expect(glassFor(dusk, {})).toEqual({ blur: 14, tint: dusk.palette.bg, opacity: 0.4 })
  expect(glassFor(dusk, { panelTint: 0.55, panelBlur: 0 })).toEqual({ blur: 0, tint: dusk.palette.bg, opacity: 0.55 })
  expect(glassFor(dusk, { panels: 'solid' })).toBe(false)
  expect(glassFor(dusk, { panels: 'clear' })).toEqual({ blur: 0, tint: dusk.palette.bg, opacity: 0 })
  expect(glassFor(dusk, { panelTint: 5, panelBlur: 99 })).toEqual({ blur: 40, tint: dusk.palette.bg, opacity: 0.9 })
  expect(schemeFor(dusk)).toBe('dark')
  expect(schemeFor(undefined)).toBe(undefined)
})

test('official route: scene names, read under scene or id, and which errors mean an older engine', async () => {
  expect(sceneName('gradient', 'dusk')).toBe('prism-gradient-dusk')
  expect(sceneName('live', 'm4a1')).toBe('prism-live-m4a1')
  expect(sceneOf({ scene: 'a', id: 'b' })).toBe('a')
  expect(sceneOf({ id: 'b' })).toBe('b')
  expect(isOlderEngine(new TypeError('x'))).toBe(true)
  expect(isOlderEngine(new Error('theme.set does not know the attribute overrideColorScheme'))).toBe(true)
  expect(isOlderEngine(new Error('disk full'))).toBe(false)
})

/** Starts Prism against a mocked engine whose theme.set answers with `answer`; returns the calls it saw. */
async function startWith($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1],
  answer: (args: Record<string, unknown>) => { deny: string } | { value: unknown }) {
  const calls: Record<string, unknown>[] = []
  on('command.register', () => ({ value: { command: 'prism' } }))
  on('session.version', () => ({ value: { version: '2.1.326', base: '2.1.326' } }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 24, 12) }))
  on('theme.set', (_, e) => { calls.push(e as Record<string, unknown>); return answer(e as Record<string, unknown>) })
  on('theme.clear', () => ({ value: { isDrawn: false, reason: 'cleared' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  const stored = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => { stored.set(e.key, e.value); return { value: undefined } })
  for (const n of ['env.get', 'ui.log', 'ui.status', 'ui.toast']) on(n as 'env.get', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  return calls
}

test('2.1.324+: one theme.set carries the colours and the scene (no id beside it), and the doctor says so', async ($, on) => {
  const calls = await startWith($, on, () => ({ value: { isDrawn: true, requestId: 'backdrop' } }))
  expect(((await $.command.run({ command: 'prism', args: 'use dusk' })) as { text?: string }).text?.startsWith('Theme: Dusk')).toBe(true)
  const last = calls.at(-1) as { backdrop: Record<string, unknown>; colors: { v: number; label: string; inputs: Record<string, unknown> }; overrideColorScheme?: string }
  expect(last.backdrop).toEqual({ scene: 'prism-gradient-dusk', glass: { blur: 14, tint: dusk.palette.bg, opacity: 0.4 } })
  expect(last.colors.v).toBe(1)
  expect(last.colors.label).toBe('Dusk')
  expect(Object.keys(last.colors.inputs)).toEqual(['dark'])
  expect(last.overrideColorScheme).toBe('dark')
  const doctor = ((await $.command.run({ command: 'prism', args: 'doctor' })) as { text?: string }).text ?? ''
  expect(doctor.includes('official backdrop: drawing')).toBe(true)
  expect(doctor.includes('official colours: painted by the desktop app')).toBe(true)
})

test('a session the desktop app is not showing: colours are sent, and the doctor says the app paints them when shown', async ($, on) => {
  await startWith($, on, () => ({ value: { isDrawn: false, requestId: 'theme', reason: 'no attached desktop client' } }))
  await $.command.run({ command: 'prism', args: 'use dusk' })
  const doctor = ((await $.command.run({ command: 'prism', args: 'doctor' })) as { text?: string }).text ?? ''
  expect(doctor.includes('official colours: sent to the desktop app')).toBe(true)
})

test('2.1.323: an engine with no colours gets the backdrop alone, and the page keeps the palette', async ($, on) => {
  const calls = await startWith($, on, args =>
    args.colors ? { deny: 'theme.set does not know the attribute colors' } : { value: { isDrawn: true, requestId: 'backdrop' } })
  await $.command.run({ command: 'prism', args: 'use dusk' })
  const last = calls.at(-1)!
  expect(last.colors).toBe(undefined)
  expect((last.backdrop as { scene: string }).scene).toBe('prism-gradient-dusk')
  const doctor = ((await $.command.run({ command: 'prism', args: 'doctor' })) as { text?: string }).text ?? ''
  expect(doctor.includes('official colours: not available')).toBe(true)
})

test('official colours: every built-in palette passes the check that would stop Desktop painting it', async () => {
  for (const t of THEMES) {
    const { theme, refused } = officialPalette(t, makeColors)
    expect(`${t.id}: ${refused ?? ''}`).toBe(`${t.id}: `)
    expect(Object.keys(theme!.inputs).sort()).toEqual(t.variants ? ['dark', 'light'] : [schemeFor(t)!])
  }
})

test('official colours: the payload keeps the palette for the page and says it was also sent to the app', async () => {
  const both = resolve(dusk, { backgroundByPage: false }) as Payload
  const app = resolve(dusk, { backgroundByPage: false, officialColors: true }) as Payload
  expect(both.officialColors).toBe(undefined)
  expect(app.officialColors).toBe(true)
  expect(app.vars['cds-surface-0']).toBe(dusk.palette.bg) // the page drops it only while the app shows a mod palette
  expect(app.vars['prism-halo']).toBe(dusk.palette.bg)
})
