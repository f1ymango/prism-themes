import { expect, test } from 'claude-code/testing'

import { alertText, describeError, doctorLines, healthFile, record, settle, stripText } from '../core/health'
import type { HealthProblem } from '../core/health'
import { OUR_FILES, freshManifest } from '../core/manifest'

test('health: a part is recorded once, replaced by its latest failure, and cleared when it works again', async () => {
  const list: HealthProblem[] = []
  expect(record(list, { part: 'apply', level: 'error', detail: 'x' })).toBe(true)
  expect(record(list, { part: 'apply', level: 'error', detail: 'x' })).toBe(false)
  expect(record(list, { part: 'apply', level: 'error', detail: 'y' })).toBe(true)
  expect(list.length).toBe(1)
  expect(settle(list, 'apply')).toBe(true)
  expect(settle(list, 'apply')).toBe(false)
  expect(describeError(new TypeError('$.ui.backdrop is not a function'))).toBe('TypeError: $.ui.backdrop is not a function')
  expect(describeError(new Error('  two\n lines '))).toBe('two lines')
})

test('health: notes stay quiet; errors alert, naming the update when the version changed', async () => {
  const note: HealthProblem = { part: 'backdrop', level: 'note', detail: 'no API' }
  const err: HealthProblem = { part: 'apply', level: 'error', detail: 'TypeError: nope' }
  expect(alertText([note])).toBe(undefined)
  expect(stripText([note])).toBe(undefined)
  expect(alertText([note, err], '2.1.321', '2.1.318')).toBe(
    'Prism needs a fix since Claude Code updated (2.1.318 → 2.1.321): applying and switching themes stopped working. ' +
    "The theme on screen may stay, but changes won't apply. Run /prism doctor for details.")
  expect(alertText([err], '2.1.321', '2.1.321')!.startsWith('Prism needs a fix: applying')).toBe(true)
  expect(stripText([err])).toBe('⚠ Not working: applying and switching themes. /prism doctor says why.')
  expect(doctorLines([], '2.1.321', '2.1.321')).toEqual(['  Claude Code: 2.1.321 (last ran with no errors on 2.1.321)', '  everything Prism tried has worked'])
  expect(doctorLines([note, err]).some(l => l === '  ✗ applying and switching themes: TypeError: nope')).toBe(true)
  expect(healthFile([note, err], 5, '2.1.321').problems).toEqual([{ ...err, name: 'applying and switching themes' }])
})

test('health: the page may read the report, and removal takes it away', async () => {
  expect(freshManifest('0.6.0').web_accessible_resources![0]!.resources!.includes('prism-health.json')).toBe(true)
  expect(OUR_FILES.includes('prism-health.json')).toBe(true)
})

const STRIP = { plugin: 'prism-themes', component: 'AbovePrompt', props: { hasSurvey: false } } as const

test('an update that breaks one part: the rest still starts, and the person is told', async ($, on) => {
  const stored = new Map<string, unknown>([['lastGood', '2.1.318']])
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'prism' } }))
  on('session.version', () => ({ value: { version: '2.1.321', base: '2.1.321' } }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 11, 12) }))
  on('theme.set', () => { throw new Error('$.theme.set is not available') }) // the official backdrop is gone: only a note
  on('theme.clear', () => ({ value: { isDrawn: false, reason: 'none' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    if (e.key === 'current') return { deny: 'store.set changed' } // switching themes breaks
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(toasts.some(t => t.startsWith('Prism needs a fix since Claude Code updated (2.1.318 → 2.1.321): applying and switching themes'))).toBe(true)
  expect(stored.get('lastGood')).toBe('2.1.318') // not a clean start: the old version stays the last good one

  await $.command.run({ command: 'prism', args: '' })
  const ui = await $.ui.mount({ ...STRIP, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^⚠ Not working/ }))?.text).toBe(
    '⚠ Not working: applying and switching themes. /prism doctor says why.')
  await ui.press({ key: 'use-dusk' })
  expect(toasts.at(-1)).toBe("Prism couldn't switch to Dusk: HooksError: prism-themes: $.store.set: store.set changed. The page may still show the old theme. /prism doctor")
  await ui.unmount()

  const doctor = ((await $.command.run({ command: 'prism', args: 'doctor' })) as { text?: string }).text ?? ''
  expect(doctor.includes('  Claude Code: 2.1.321 (last ran with no errors on 2.1.318)')).toBe(true)
  expect(doctor.includes('  ✗ applying and switching themes: HooksError: prism-themes: $.store.set: store.set changed')).toBe(true)
})

test('a clean start remembers the version it ran on', async ($, on) => {
  const stored = new Map<string, unknown>([['lastGood', '2.1.318']])
  on('command.register', () => ({ value: { command: 'prism' } }))
  on('session.version', () => ({ value: { version: '2.1.321', base: '2.1.321' } }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 11, 12) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => { stored.set(e.key, e.value); return { value: undefined } })
  for (const n of ['env.get', 'ui.log', 'ui.status', 'ui.toast']) on(n as 'env.get', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(stored.get('lastGood')).toBe('2.1.321')
})
