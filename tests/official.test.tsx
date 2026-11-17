import { expect, test } from 'claude-code/testing'

import { glassFor, isOlderEngine, sceneName, sceneOf, schemeFor } from '../core/official'
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
  expect(sceneOf({ scene: 'a', id: 'b' })).toBe('a')
  expect(sceneOf({ id: 'b' })).toBe('b')
  expect(isOlderEngine(new TypeError('x'))).toBe(true)
  expect(isOlderEngine(new Error('theme.set does not know the attribute overrideColorScheme'))).toBe(true)
  expect(isOlderEngine(new Error('disk full'))).toBe(false)
})

test('a gradient theme goes to the official backdrop, falling back to the 2.1.319 shape', async ($, on) => {
  const calls: unknown[] = []
  on('command.register', () => ({ value: { command: 'prism' } }))
  on('session.version', () => ({ value: { version: '2.1.321', base: '2.1.321' } }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 17, 12) }))
  on('theme.set', (_, e) => {
    calls.push(e)
    const args = e as { overrideColorScheme?: string }
    if (args.overrideColorScheme) return { deny: 'theme.set does not know the attribute overrideColorScheme' }
    return { value: { isDrawn: true, requestId: 'backdrop' } }
  })
  on('theme.clear', () => ({ value: { isDrawn: false, reason: 'cleared' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  const stored = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => { stored.set(e.key, e.value); return { value: undefined } })
  for (const n of ['env.get', 'ui.log', 'ui.status', 'ui.toast']) on(n as 'env.get', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(((await $.command.run({ command: 'prism', args: 'use dusk' })) as { text?: string }).text?.startsWith('Theme: Dusk')).toBe(true)
  const last = calls.at(-1) as { backdrop: { id: string; glass: unknown; colorScheme?: string } }
  expect(last.backdrop.id).toBe('prism-gradient-dusk')
  expect(last.backdrop.colorScheme).toBe('dark')
  expect(last.backdrop.glass).toEqual({ blur: 14, tint: dusk.palette.bg, opacity: 0.4 })
  const doctor = ((await $.command.run({ command: 'prism', args: 'doctor' })) as { text?: string }).text ?? ''
  expect(doctor.includes('official backdrop: drawing')).toBe(true)
})
