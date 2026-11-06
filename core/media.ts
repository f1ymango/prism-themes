// C3 + C7: what a background file is, judged by its first bytes, never by its name; and what we accept.

export type MediaKind = 'jpeg' | 'png' | 'gif' | 'webp' | 'avif' | 'svg' | 'mp4' | 'webm'
export type Provider = 'image' | 'slideshow' | 'svg' | 'video'

export const EXT: Record<MediaKind, string> = {
  jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', avif: 'avif', svg: 'svg', mp4: 'mp4', webm: 'webm',
}

const MB = 1024 * 1024
export const LIMIT_BYTES = { image: 15 * MB, svg: 2 * MB, video: 50 * MB }
export const MAX_SLIDES = 50

export const isVideo = (k: MediaKind) => k === 'mp4' || k === 'webm'
export const isRaster = (k: MediaKind) => !isVideo(k) && k !== 'svg'
export const limitOf = (k: MediaKind) => (isVideo(k) ? LIMIT_BYTES.video : k === 'svg' ? LIMIT_BYTES.svg : LIMIT_BYTES.image)

// ISO base media brands Chromium plays as MP4; QuickTime (`qt  `) and HEIF are left out
const MP4_BRANDS = ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash', 'mmp4']

const ascii = (hex: string) => hex.match(/../g)?.map(b => String.fromCharCode(parseInt(b, 16))).join('') ?? ''

/** The kind of file from up to its first 512 bytes as lowercase hex, or undefined when it is none we accept. */
export const sniff = (hexIn: string): MediaKind | undefined => {
  const hex = hexIn.replace(/[^0-9a-f]/gi, '').toLowerCase()
  if (hex.startsWith('ffd8ff')) return 'jpeg'
  if (hex.startsWith('89504e470d0a1a0a')) return 'png'
  if (hex.startsWith('47494638')) return 'gif'
  if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return 'webp'
  if (hex.startsWith('1a45dfa3')) return 'webm'
  if (hex.slice(8, 16) === '66747970') {
    const brand = ascii(hex.slice(16, 24))
    if (brand === 'avif' || brand === 'avis') return 'avif'
    return MP4_BRANDS.includes(brand) ? 'mp4' : undefined
  }
  const text = ascii(hex).replace(/^﻿|^ï»¿/, '').trimStart()
  if (text.startsWith('<') && /<svg[\s>]/i.test(text)) return 'svg'
  return undefined
}

export type Checked = { path: string; kind: MediaKind; size: number; mtimeMs: number }

/** Why a file is refused, or undefined when it is fine. */
export const refusal = (path: string, kind: MediaKind | undefined, size: number): string | undefined => {
  const name = path.split(/[\\/]/).pop()
  if (!kind) return `${name} is not an image, SVG or video this mod accepts (JPEG, PNG, GIF, WebP, AVIF, SVG, MP4, WebM)`
  if (size > limitOf(kind)) return `${name} is ${Math.ceil(size / MB)} MB; the limit for ${isVideo(kind) ? 'a video' : kind === 'svg' ? 'an SVG' : 'an image'} is ${limitOf(kind) / MB} MB`
  return undefined
}

/** One file of any accepted kind, or a folder's images as a slideshow. */
export const providerFor = (files: Checked[]): Provider | undefined => {
  if (!files.length) return undefined
  if (files.length > 1) return files.every(f => isRaster(f.kind)) ? 'slideshow' : undefined
  const k = files[0]!.kind
  return isVideo(k) ? 'video' : k === 'svg' ? 'svg' : 'image'
}

/** A stable file name for the copy in the extension folder: changes when the source file does. */
export const assetName = (f: Checked) => {
  let h = 0x811c9dc5
  for (const c of `${f.path}|${f.size}|${f.mtimeMs}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0
  return `bg-${h.toString(16).padStart(8, '0')}.${EXT[f.kind]}`
}

/** The custom background as the person set it with /prism bg. */
export type CustomBackground = {
  files: Checked[]
  provider: Provider
  interval: number
  fit: 'cover' | 'contain'
  dim: number
}
