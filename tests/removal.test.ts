import { expect, test } from 'claude-code/testing'

import { infoOf, planRemove, removedEntries, removedName } from '../core/removal'

const files = [
  infoOf('miku.json', { id: 'miku', css: 'miku.css', background: { file: 'D:/Wallpapers/miku.mp4' } }),
  infoOf('punklorde.json', { id: 'punklorde', css: 'punklorde.css' }),
  infoOf('rain.json', { id: 'afterschool-rain', background: { file: 'rain.mp4' } }),
  infoOf('broken.json', undefined),
]
const builtins = ['dusk', 'paper']

test('remove: your own theme moves with its stylesheet; a background file outside the folder is never touched', async () => {
  expect(planRemove(files, 'miku', builtins)).toEqual({ json: 'miku.json', css: 'miku.css', keepCss: false, media: undefined })
  expect(planRemove(files, 'afterschool-rain', builtins)).toEqual({ json: 'rain.json', css: undefined, keepCss: false, media: 'rain.mp4' })
  expect(infoOf('broken.json', undefined)).toEqual({ file: 'broken.json', id: undefined, extends: undefined, css: undefined, media: undefined })
})

test('remove: built-ins, unknown ids, duplicates and themes others extend are refused', async () => {
  expect((planRemove(files, 'dusk', builtins) as { error: string }).error.startsWith('dusk is a built-in theme')).toBe(true)
  expect((planRemove(files, 'nope', builtins) as { error: string }).error).toBe('No theme of yours has the id "nope". /prism doctor lists yours.')
  const twice = [...files, infoOf('miku-copy.json', { id: 'miku' })]
  expect((planRemove(twice, 'miku', builtins) as { error: string }).error.startsWith('More than one file has the id "miku"')).toBe(true)
  const child = [...files, infoOf('miku-night.json', { id: 'miku-night', extends: 'miku' })]
  expect((planRemove(child, 'miku', builtins) as { error: string }).error).toBe('miku-night extends miku. Remove that first, or change their "extends".')
})

test('remove: a stylesheet another theme also uses stays', async () => {
  const shared = [...files, infoOf('miku-2.json', { id: 'miku-two', css: 'miku.css' })]
  expect(planRemove(shared, 'miku', builtins)).toEqual({ json: 'miku.json', css: 'miku.css', keepCss: true, media: undefined })
})

test('restore: removed folders are named by time, read newest first, and odd folders are skipped', async () => {
  expect(removedName('miku', new Date(2026, 10, 11, 9, 5, 7))).toBe('miku~20261111-090507')
  expect(removedEntries(['miku~20261110-120000', 'miku~20261111-090507', 'notes', 'Bad~1', 'rain~20261101-000000'])).toEqual([
    { folder: 'rain~20261101-000000', id: 'rain' },
    { folder: 'miku~20261111-090507', id: 'miku' },
    { folder: 'miku~20261110-120000', id: 'miku' },
  ])
})
