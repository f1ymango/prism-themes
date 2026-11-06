import type { Theme } from './resolve'

// Milestone 1: a few hardcoded themes. Schema v2 and the person's own themes come in Phase 3 (C6).
export const THEMES: Theme[] = [
  {
    id: 'dusk', name: 'Dusk', tagline: 'Violet evening, coral accent, a gradient sky behind the chat',
    palette: { bg: '#241c2e', text: '#f4e8ee', accent: '#ff8a6b' },
    radius: { base: 10, composer: 20 },
    background: { kind: 'gradient', angle: 160, stops: ['#1b1430', '#3a2350', '#7a3d5c', '#c0645a'] },
  },
  {
    id: 'harbor', name: 'Harbor', tagline: 'Deep sea blue, calm and plain, no background picture',
    palette: { bg: '#0f1a2c', text: '#dce6fa', accent: '#5aaeff' },
    radius: { base: 8, composer: 16 },
  },
  {
    id: 'parchment', name: 'Parchment', tagline: 'Ivory paper, ink-brown text, a serif face',
    palette: { bg: '#f2e9d6', text: '#3a2f22', accent: '#a5522c' },
    font: "Georgia, 'Times New Roman', serif",
    radius: { base: 3, composer: 4 },
  },
]

export const themeOf = (id: string | undefined) => THEMES.find(t => t.id === id)
