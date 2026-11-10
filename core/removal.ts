// /prism remove and /prism restore: your own themes move to a "removed" folder beside "themes" instead of being
// deleted, so a removal can be undone. Pure planning here; hooks/host.ts moves the files.
import { ID } from './schema'

/** What one theme file in the themes folder says about itself. */
export type ThemeFileInfo = { file: string; id?: string; extends?: string; css?: string; media?: string }

export type RemovePlan = { error: string } | { json: string; css?: string; keepCss: boolean; media?: string }

/** Reads the parts of a theme file that removal cares about; anything unreadable is left undefined. */
export function infoOf(file: string, raw: unknown): ThemeFileInfo {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const bg = o.background && typeof o.background === 'object' ? (o.background as Record<string, unknown>) : {}
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return { file, id: s(o.id), extends: s(o.extends), css: s(o.css), media: s(bg.file) }
}

const isRelative = (p: string) => !/^[a-zA-Z]:[\\/]|^[\\/]/.test(p) && !/[\\/]/.test(p)

/** Which files to move for theme `id`, or why it cannot be removed. */
export function planRemove(files: ThemeFileInfo[], id: string, builtinIds: string[]): RemovePlan {
  const own = files.filter(f => f.id === id)
  if (!own.length) {
    return builtinIds.includes(id)
      ? { error: `${id} is a built-in theme and cannot be removed. Your own themes are listed under "Yours" in /prism.` }
      : { error: `No theme of yours has the id "${id}". /prism doctor lists yours.` }
  }
  if (own.length > 1) return { error: `More than one file has the id "${id}" (${own.map(f => f.file).join(', ')}). Remove one by hand first.` }
  const theme = own[0]!
  const children = files.filter(f => f.extends === id && f.id !== id).map(f => f.id ?? f.file)
  if (children.length) {
    return { error: `${children.join(', ')} ${children.length > 1 ? 'extend' : 'extends'} ${id}. Remove ${children.length > 1 ? 'those' : 'that'} first, or change their "extends".` }
  }
  const css = theme.css && isRelative(theme.css) ? theme.css : undefined
  const keepCss = !!css && files.some(f => f !== theme && f.css === css)
  // a picture or video beside the theme stays where it is: it may be large, and it is yours rather than Prism's
  const media = theme.media && isRelative(theme.media) ? theme.media : undefined
  return { json: theme.file, css, keepCss, media }
}

const two = (n: number) => String(n).padStart(2, '0')

/** The folder a removal goes into: removed/<id>~<local date and time>. */
export function removedName(id: string, now: Date): string {
  return `${id}~${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
}

/** The removed themes, newest first: { id, folder }. */
export function removedEntries(folders: string[]): { id: string; folder: string }[] {
  return folders
    .map(folder => ({ folder, id: folder.split('~')[0]! }))
    .filter(e => ID.test(e.id) && e.folder.includes('~'))
    .sort((a, b) => b.folder.localeCompare(a.folder))
}
