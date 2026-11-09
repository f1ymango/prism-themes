import { expect, test } from 'claude-code/testing'

import { resolve } from '../core/resolve'
import type { Payload, Theme } from '../core/resolve'
import { ROLES, WALL_RULES } from '../core/roles'
import { THEMES } from '../core/themes'

const media = { provider: 'video' as const, files: ['prism-assets/bg-00000001.mp4'], interval: 60, fit: 'cover' as const, dim: 0.3 }
const dusk = THEMES.find(t => t.id === 'dusk')!

test('glass panels have their own, lighter tint than the composer', async () => {
  const p = resolve(dusk, { backgroundByPage: false, media }) as Payload
  expect(p.vars['prism-glass']).toBe('rgba(36, 28, 46, 0.6)') // the composer keeps its tint
  expect(p.vars['prism-panel']).toBe('rgba(36, 28, 46, 0.4)')
  const rule = WALL_RULES.find(r => r.id === 'panels')!.css
  expect(rule.includes('background: var(--prism-panel, var(--prism-glass))')).toBe(true)
  expect(ROLES.composer!.length > 0).toBe(true)
})

test('/prism glass sets the panel tint for every palette, and is clamped', async () => {
  expect((resolve(dusk, { backgroundByPage: false, media, panelTint: 0.2 }) as Payload).vars['prism-panel']).toBe('rgba(36, 28, 46, 0.2)')
  expect((resolve(dusk, { backgroundByPage: false, media, panelTint: 5 }) as Payload).vars['prism-panel']).toBe('rgba(36, 28, 46, 0.9)')
  const duo: Theme = {
    id: 'duo', name: 'Duo', tagline: '', palette: { bg: '#15142b', text: '#f7ece2', accent: '#ff8fb6' },
    variants: { light: { bg: '#fbf2ea', text: '#2b2140', accent: '#c1306a' }, dark: { bg: '#15142b', text: '#f7ece2', accent: '#ff8fb6' } },
  }
  const v = resolve(duo, { backgroundByPage: false, media, panelTint: 0.25 }) as Payload
  expect(v.variants?.light['prism-panel']).toBe('rgba(251, 242, 234, 0.25)')
  expect(v.variants?.dark['prism-panel']).toBe('rgba(21, 20, 43, 0.25)')
  const own = resolve(undefined, { backgroundByPage: false, media, panelTint: 0.15 }) as Payload
  expect(own.vars['prism-panel']).toBe('color-mix(in srgb, var(--cds-surface-1) 15%, transparent)')
  expect((resolve(undefined, { backgroundByPage: false, media }) as Payload).vars['prism-panel'])
    .toBe('color-mix(in srgb, var(--cds-surface-1) 30%, transparent)')
})

test('/prism blur sets the blur behind glass panels; 0 is crisp, and it is clamped', async () => {
  const rule = WALL_RULES.find(r => r.id === 'panels')!.css
  expect(rule.includes('backdrop-filter: blur(var(--prism-panel-blur, 14px))')).toBe(true) // 14 px unless set
  expect((resolve(dusk, { backgroundByPage: false, media }) as Payload).vars['prism-panel-blur']).toBe(undefined)
  expect((resolve(dusk, { backgroundByPage: false, media, panelBlur: 0 }) as Payload).vars['prism-panel-blur']).toBe('0px')
  expect((resolve(undefined, { backgroundByPage: false, media, panelBlur: 99 }) as Payload).vars['prism-panel-blur']).toBe('40px')
})
