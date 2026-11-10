import { expect, test } from 'claude-code/testing'

import { resolve } from '../core/resolve'
import type { Payload } from '../core/resolve'
import { REACTION_RULES } from '../core/roles'
import {
  ALIASES, SETTINGS, changedSummary, cleanSettings, describeSettings, findSetting, migrateLegacy, parseValue,
} from '../core/settings'
import type { SettingDef } from '../core/settings'
import { THEMES } from '../core/themes'

const def = (k: string) => findSetting(k) as SettingDef

test('settings: keys, shortcuts and values are checked, with units allowed', async () => {
  expect(def('panels.blur').key).toBe('panels.blur')
  expect(def('BLUR').key).toBe('panels.blur') // the old short command, any case
  expect(def('glass').key).toBe('panels.tint')
  expect(def('every').key).toBe('background.interval')
  expect(String(findSetting('sparkles')).startsWith('No setting "sparkles". The settings are: panels.style')).toBe(true)
  expect(parseValue(def('panels.blur'), '0px')).toEqual({ value: 0 })
  expect(parseValue(def('background.interval'), '30s')).toEqual({ value: 30 })
  expect(parseValue(def('composer.tint'), '1.2')).toEqual({ error: 'composer.tint is a number from 0 to 0.9' })
  expect(parseValue(def('reactions'), 'OFF')).toEqual({ value: 'off' })
  expect(parseValue(def('panels.style'), 'frosted')).toEqual({ error: 'panels.style is one of: glass, clear, solid' })
  for (const target of Object.values(ALIASES)) expect(SETTINGS.some(s => s.key === target)).toBe(true)
})

test('settings: stored values are cleaned, and the older separate values move in', async () => {
  expect(cleanSettings({ 'panels.blur': 0, 'panels.tint': 7, 'made.up': 1, reactions: 'off' })).toEqual({ 'panels.blur': 0, reactions: 'off' })
  expect(cleanSettings('nope')).toEqual({})
  expect(migrateLegacy({ panels: 'glass', panelTint: 0.55, panelBlur: 0 })).toEqual({ 'panels.style': 'glass', 'panels.tint': 0.55, 'panels.blur': 0 })
  expect(migrateLegacy({})).toEqual({})
  expect(changedSummary({ 'panels.blur': 0, 'panels.tint': 0.55 })).toBe('panels.tint 0.55 · panels.blur 0px')
  const lines = describeSettings({ 'panels.blur': 0 })
  expect(lines.length).toBe(SETTINGS.length)
  expect(lines.find(l => l.startsWith('panels.blur'))!.includes('0px (set)')).toBe(true)
  expect(lines.find(l => l.startsWith('background.dim'))!.includes("the theme's own")).toBe(true)
})

const dusk = THEMES.find(t => t.id === 'dusk')!
const media = { provider: 'video' as const, files: ['prism-assets/bg-00000001.mp4'], interval: 60, fit: 'cover' as const, dim: 0.3 }

test('settings reach the page: composer tint and blur, text halo, reactions off', async () => {
  const p = resolve(dusk, { backgroundByPage: false, media, composerTint: 0.3, composerBlur: 0, haloSize: 0, reactions: false }) as Payload
  expect(p.vars['prism-glass']).toBe('rgba(36, 28, 46, 0.3)')
  expect(p.vars['prism-composer-blur']).toBe('0px')
  expect(p.vars['prism-halo-size']).toBe('0px')
  expect(p.rules.some(r => REACTION_RULES.includes(r))).toBe(false)
  const rules = p.rules.map(r => r.css).join('\n')
  expect(rules.includes('blur(var(--prism-composer-blur, 10px))')).toBe(true)
  expect(rules.includes('0 0 var(--prism-halo-size, 8px) var(--prism-halo)')).toBe(true)
  const plain = resolve(dusk, { backgroundByPage: false, media }) as Payload
  expect(plain.vars['prism-composer-blur']).toBe(undefined)
  expect(plain.rules.some(r => r.id === 'tool-glow')).toBe(true) // reactions stay on unless set off
})

test('the commands: /prism set lists and changes, the shortcuts still work, reset undoes', async ($, on) => {
  const stored = new Map<string, unknown>([['panelBlur', 0], ['panelTint', 0.55]]) // what the older version kept
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => { stored.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_, e) => { stored.delete(e.key); return { value: undefined } })
  for (const n of ['env.get', 'ui.log', 'ui.status', 'ui.toast']) on(n as 'env.get', () => ({ value: undefined }))
  on('theme.set', () => ({ value: { isDrawn: false, reason: 'none' } }))
  on('theme.clear', () => ({ value: { isDrawn: false, reason: 'none' } }))
  on('command.register', () => ({ value: { command: 'prism' } }))
  const run = async (args: string) => ((await $.command.run({ command: 'prism', args })) as { text?: string }).text ?? ''

  expect((await run('set')).includes('panels.blur          0px (set)')).toBe(true) // the old values moved in
  expect(stored.get('settings')).toEqual({ 'panels.tint': 0.55, 'panels.blur': 0 })
  expect(await run('set composer.blur 0')).toBe('composer.blur: 0px. blur behind the box you type in (0 is crisp).')
  expect(await run('glass 0.3')).toBe('panels.tint: 0.3. how strongly glass panels are tinted (lower is clearer).')
  expect(await run('set reactions maybe')).toBe('Usage: /prism set reactions <value> — reactions is one of: on, off, or default')
  expect(await run('reset composer.blur')).toBe('composer.blur is back to its default (10).')
  expect(stored.get('settings')).toEqual({ 'panels.tint': 0.3, 'panels.blur': 0 })
  expect(await run('reset all')).toBe('All settings are back to their defaults.')
  expect(stored.get('settings')).toEqual({})
})
