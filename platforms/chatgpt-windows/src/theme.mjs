export function normalizeTheme(value = {}) {
  const fonts = ['auto', 'modern', 'rounded', 'serif', 'mono'];
  const hex = /^#[0-9a-fA-F]{6}$/;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['mode', 'font', 'tint', 'accent', 'opacity', 'radius'].includes(key))) {
    throw new Error('Invalid theme settings.');
  }
  const theme = { mode: 'auto', font: 'auto', tint: null, accent: null, opacity: 0.76, radius: 14, ...value };
  if (!['auto', 'off'].includes(theme.mode)) throw new Error('Theme mode must be auto or off.');
  if (!fonts.includes(theme.font)) throw new Error('Theme font must be auto, modern, rounded, serif, or mono.');
  for (const key of ['tint', 'accent']) if (theme[key] !== null && (typeof theme[key] !== 'string' || !hex.test(theme[key]))) throw new Error(`Theme ${key} must be a six-digit hex colour.`);
  if (typeof theme.opacity !== 'number' || !Number.isFinite(theme.opacity) || theme.opacity < 0.45 || theme.opacity > 0.9) throw new Error('Theme opacity must be from 0.45 to 0.9.');
  if (!Number.isInteger(theme.radius) || theme.radius < 0 || theme.radius > 28) throw new Error('Theme radius must be an integer from 0 to 28.');
  theme.tint = theme.tint?.toLowerCase() ?? null;
  theme.accent = theme.accent?.toLowerCase() ?? null;
  return theme;
}

// Uses a small canvas sample from a decoded image or video frame. The result is
// intentionally restrained so native text retains contrast on either app mode.
export function deriveTheme(pixels, theme, light) {
  if (theme.mode === 'off') return null;
  let red = 0, green = 0, blue = 0, total = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    if (alpha < 0.5) continue;
    const r = pixels[i] / 255, g = pixels[i + 1] / 255, b = pixels[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), chroma = max - min;
    const brightness = (max + min) / 2;
    const weight = alpha * (0.04 + chroma * chroma) * (0.35 + 0.65 * (1 - Math.abs(brightness - 0.5) * 2));
    red += r * weight; green += g * weight; blue += b * weight; total += weight;
  }
  const r = total ? red / total : 0.35, g = total ? green / total : 0.68, b = total ? blue / total : 0.72;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = ((hue * 60) + 360) % 360;
  }
  const saturation = delta / (1 - Math.abs(max + min - 1) || 1);
  const chroma = (1 - Math.abs(2 * (light ? 0.39 : 0.68) - 1)) * Math.max(0.4, Math.min(0.72, saturation || 0.4));
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = (light ? 0.39 : 0.68) - chroma / 2;
  const channels = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  const hex = values => '#' + values.map(value => Math.round(value).toString(16).padStart(2, '0')).join('');
  const accent = theme.accent ?? hex(channels.map(value => (value + m) * 255));
  const accentRgb = [1, 3, 5].map(index => parseInt(accent.slice(index, index + 2), 16));
  const base = light ? 248 : 24;
  const tint = theme.tint ?? hex(accentRgb.map(value => base * 0.84 + value * 0.16));
  const font = theme.font === 'auto' ? (hue >= 150 && hue <= 230 && saturation > 0.25 ? 'rounded' : hue >= 20 && hue <= 70 ? 'serif' : 'modern') : theme.font;
  return { accent, tint, font, opacity: theme.opacity, radius: theme.radius };
}
