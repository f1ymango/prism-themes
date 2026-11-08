// Serialized with the renderer runtime. Theme only reviewed app surfaces; never
// change native theme variables or blanket-reset backgrounds on controls/content.
export function wallpaperStyle(runId, theme = null) {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(runId ?? '')) throw new Error('Invalid wallpaper owner.');
  const root = `html[data-prism-wallpaper="${runId}"]`;
  const exclude = ':not([role="dialog"],[aria-modal="true"],[role="dialog"] *,[aria-modal="true"] *)';
  const scope = selectors => selectors.map(selector => `${root} #root ${selector}${exclude}`).join(',\n');
  const fade = scope([
    '[class*="MainContentTopFade-"]',
    '.thread-scroll-container [class*="background-"][class*="fade-"].pointer-events-none',
    '[data-thread-scroll-footer] > .pointer-events-none',
    '[data-thread-scroll-footer] > .pointer-events-none *',
  ]);
  const panels = scope([
    '[data-summary-panel-variant="summary"]',
    '[data-composer-layout][data-composer-surface-variant="default"]',
    '[class*="--resource-card-row-padding-x:"]',
  ]);
  const headers = scope([
    '[data-summary-panel-variant="summary"] header',
    '[class*="--resource-card-row-padding-x:"] div.bg-surface:not([role="button"]):not(pre *,code *)',
    '[class*="--resource-card-row-padding-x:"] div.bg-surface-elevated-secondary:not([role="button"]):not(pre *,code *)',
    '[class*="--resource-card-row-padding-x:"] div.bg-background-primary:not([role="button"]):not(pre *,code *)',
  ]);
  const headerBefore = scope(['[data-summary-panel-variant="summary"] header']).split(',\n').map(selector => `${selector}::before`).join(',\n');
  const fadePseudo = fade.split(',\n').flatMap(selector => [`${selector}::before`, `${selector}::after`]).join(',\n');
  const font = { modern: '"Segoe UI",Arial,sans-serif', rounded: '"Trebuchet MS","Segoe UI",sans-serif', serif: 'Georgia,"Times New Roman",serif', mono: 'Consolas,"Cascadia Code",monospace' }[theme?.font];
  const tint = theme ? `${theme.tint}${Math.round(theme.opacity * 255).toString(16).padStart(2, '0')}` : 'color-mix(in srgb,var(--color-surface,#181818) 65%,transparent)';
  const themed = theme ? `
${root} #root{font-family:${font}!important;--prism-theme-accent:${theme.accent}}
${root} #root :is(button,input,textarea,select){font-family:${font}!important}
${root} #root a:not([role="button"]):hover{color:var(--prism-theme-accent)!important}
${root} #root :is(button,input,textarea,select,a):focus-visible{outline-color:var(--prism-theme-accent)!important}
${panels}{border-radius:${theme.radius}px!important;border-color:color-mix(in srgb,var(--prism-theme-accent) 35%,transparent)!important}` : '';
  return `${root}{isolation:isolate!important;--prism-wallpaper-panel-tint:${tint}}
${root} [data-prism-wallpaper-surface="${runId}"]{background-color:transparent!important}
${fade},${fadePseudo}{background-color:transparent!important;background-image:none!important;box-shadow:none!important}
${panels}{background-color:var(--prism-wallpaper-panel-tint)!important}
${theme ? '' : `${scope(['[data-composer-layout][data-composer-surface-variant="default"][data-composer-dark]'])}{background-color:rgba(24,24,24,.65)!important}`}
${headers},${headerBefore}{background-color:transparent!important;background-image:none!important}${themed}`;
}
