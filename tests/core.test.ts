import { expect, test } from 'claude-code/testing'

import { etimeSeconds, fromProcesses, join, markerTarget, parseMacProcs, parseWinProcs, pick, userDataOf } from '../core/discover'
import { hasOurs, parseRecord, withOurs, withoutOurs } from '../core/manifest'
import type { Manifest } from '../core/manifest'
import { modeOf, varsOf } from '../core/palette'
import { gradientSvg, safeCss } from '../core/resolve'

const EXE = 'C:\\Program Files\\WindowsApps\\Claude_4.16336.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe'
const DATA = 'C:\\Users\\me\\AppData\\Local\\Claude-Data\\claude_pzs8sxrjxfjjc'

test('C1: the running app names its data folder, quoted or not', async () => {
  const out = [
    `1700000000000|"${EXE}" `,
    `1700000000500|"${EXE}" --type=gpu-process --user-data-dir="${DATA}" --gpu-preferences=X`,
    `1700000000600|"${EXE}" --type=crashpad-handler --user-data-dir=${DATA} /prefetch:4`,
    'garbage line',
  ].join('\r\n')
  const procs = parseWinProcs(out)
  expect(procs.length).toBe(3)
  const found = fromProcesses(procs)
  expect(found.dirs).toEqual([DATA])
  expect(found.appStartedMs).toBe(1700000000000) // the main process, not a helper
  expect(userDataOf('Claude.exe --type=renderer')).toBe(undefined)
})

test('C1: macOS elapsed times and process lines', async () => {
  expect(etimeSeconds('05:07')).toBe(307)
  expect(etimeSeconds('1:00:00')).toBe(3600)
  expect(etimeSeconds('2-00:00:01')).toBe(172801)
  expect(etimeSeconds('nope')).toBe(undefined)
  const procs = parseMacProcs('  01:40 /Applications/Claude.app/Contents/MacOS/Claude\n 00:10 /usr/bin/other\n', 1_000_000)
  expect(procs).toEqual([{ startedMs: 900_000, cmd: '/Applications/Claude.app/Contents/MacOS/Claude' }])
})

test('C1: the move marker and the choice between candidates', async () => {
  expect(markerTarget(['.user-data-left.claude_pzs8sxrjxfjjc'])).toBe('claude_pzs8sxrjxfjjc')
  expect(markerTarget(['config.json'])).toBe(undefined)
  expect(markerTarget(['.user-data-left.../evil'])).toBe(undefined)
  const best = pick([
    { path: 'classic', source: 'classic', live: false, mtimeMs: 9 },
    { path: 'msix', source: 'msix', live: true, mtimeMs: 5 },
    { path: 'moved', source: 'marker', live: true, mtimeMs: 1 },
  ])
  expect(best?.path).toBe('moved')
  expect(pick([{ path: 'x', source: 'classic', live: false, mtimeMs: 1 }])).toBe(undefined)
  expect(join('C:\\a\\', 'b', 'c')).toBe('C:\\a\\b\\c')
  expect(join('/Users/me', 'Library')).toBe('/Users/me/Library')
})

test('C8: our manifest entries go in and come out without touching another extension', async () => {
  const devtools: Manifest = {
    manifest_version: 3, name: 'React Developer Tools',
    content_scripts: [{ matches: ['<all_urls>'], js: ['build/hook.js'] }],
    web_accessible_resources: [{ resources: ['main.html'], matches: ['<all_urls>'] }],
  }
  const merged = withOurs(devtools, '0.1.0')
  expect(hasOurs(merged)).toBe(true)
  expect(merged.name).toBe('React Developer Tools')
  expect(withOurs(merged, '0.1.0').content_scripts?.length).toBe(2) // installing twice adds nothing
  expect(withoutOurs(merged)).toEqual(devtools)
  expect(withoutOurs(withOurs(undefined, '0.1.0'))).toBe(undefined)
  expect(withOurs(undefined, '0.1.0').content_scripts?.[0]?.matches).toEqual(['https://claude.ai/*'])
  expect(withOurs(undefined, '0.1.0').web_accessible_resources?.[0]?.resources)
    .toEqual(['prism-theme.json', 'events/*.json', 'prism-assets/*'])
  expect(gradientSvg({ kind: 'gradient', angle: 90, stops: ['#000000', '#ffffff'] }).startsWith('<svg')).toBe(true)
})

test('C8: install records', async () => {
  expect(parseRecord('nope')).toBe(undefined)
  expect(parseRecord('{"installedAt":1,"setEnv":true,"version":"0.1.0","userData":"x","slotExisted":false,"extensionsExisted":false}')?.setEnv).toBe(true)
})

test('C2: palettes and the CSS filter', async () => {
  expect(modeOf({ bg: '#f2e9d6', text: '#3a2f22', accent: '#a5522c' })).toBe('light')
  expect(varsOf({ bg: '#000000', text: '#ffffff', accent: '#ffff00' })['cds-on-accent']).toBe('#000000')
  expect(safeCss('a { background: url(https://evil.example/x.png) }')).toBe(false)
  expect(safeCss('@import "x.css";')).toBe(false)
  expect(safeCss('a { background: u\\72l(x) }')).toBe(false)
  expect(safeCss('a { background: url("data:image/png;base64,AAAA") }')).toBe(true)
})
