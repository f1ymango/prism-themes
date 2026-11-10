import { expect, test } from 'claude-code/testing'

const STRIP = { plugin: 'prism-themes', component: 'AbovePrompt', props: { hasSurvey: false } } as const

test('the strip reports a missing backdrop layer and offers the extension, on every surface', async ($, on) => {
  on('command.register', () => ({ value: { command: 'prism' } }))
  on('session.version', () => ({ value: { version: '2.1.321', base: '2.1.321' } }))
  on('theme.clear', () => ({ value: { isDrawn: false, reason: 'cleared' } }))
  on('theme.set', () => ({
    value: { isDrawn: false, reason: 'no attached desktop client says it draws backdrops (a desktop app with the backdrop layer does, on its ui_attach)' },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  // nothing else beneath the plugin: no env (so no OS is detected and no file or process is touched)
  const stored = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => { stored.set(e.key, e.value); return { value: undefined } })
  on('env.get', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'prism', args: '' })

  const first = await $.ui.mount({ ...STRIP, surface: 'desktop' })
  expect((await first.find({ type: 'Text', text: /^Backdrop \(official API\)/ }))?.text).toBe(
    'Backdrop (official API): not tried yet (pick a theme with a background)')
  expect((await first.find({ type: 'Text', text: /^Extension/ }))?.text).toBe('Extension: not supported on this system')
  await first.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...STRIP, surface })
    await ui.press({ key: 'use-dusk' })
    expect((await ui.find({ type: 'Text', text: /^Backdrop/ }))?.text).toBe(
      'Backdrop (official API): unavailable: this app version has no backdrop layer')
    expect((await ui.find({ type: 'Text', text: /background needs the extension/ }))?.text).toBe(
      "Dusk's background needs the extension (or a Claude Desktop with the backdrop layer).")
    await ui.unmount()
  }
})
