// /prism census: which Svg features the desktop app draws in a backdrop. 24 numbered tiles, 6 across; each sits on red,
// and a feature that works turns its tile green (or shows the movement named in CENSUS_LEGEND). Everything here keeps
// to the backdrop rules: no images, data: or base64, and only local #fragment references.

const T = 200 // a tile, in viewBox units
const tile = (k: number, body: string) => {
  const x = (k % 6) * T + 10, y = Math.floor(k / 6) * T + 10
  return `<g transform="translate(${x} ${y})"><rect width="180" height="180" fill="#c22"/>${body}` +
    `<text x="8" y="26" font-family="sans-serif" font-size="22" fill="#fff">${k + 1}</text></g>`
}
const full = (extra: string) => `<rect width="180" height="180" ${extra}/>`

const defs = `<defs>
<linearGradient id="lg"><stop offset="0" stop-color="#2c2"/><stop offset="1" stop-color="#2c2"/></linearGradient>
<radialGradient id="rg"><stop offset="0" stop-color="#2c2"/><stop offset="1" stop-color="#2c2"/></radialGradient>
<pattern id="pt" width="30" height="30" patternUnits="userSpaceOnUse"><rect width="30" height="30" fill="#2c2"/><rect width="15" height="15" fill="#195"/><rect x="15" y="15" width="15" height="15" fill="#195"/></pattern>
<rect id="us" width="180" height="180" fill="#2c2"/>
<clipPath id="cp"><rect width="180" height="180"/></clipPath>
<mask id="mk"><rect width="180" height="180" fill="#fff"/></mask>
<filter id="f8" x="0" y="0" width="1" height="1"><feFlood flood-color="#2c2"/></filter>
<filter id="f9"><feColorMatrix type="matrix" values="0 0 0 0 0.13  0.8 0 0 0 0  0 0 0 0 0.13  0 0 0 1 0"/></filter>
<filter id="f10"><feComponentTransfer><feFuncR type="table" tableValues="0.13 0.13"/><feFuncG type="table" tableValues="0.8 0.8"/><feFuncB type="table" tableValues="0.13 0.13"/></feComponentTransfer></filter>
<filter id="f11" x="0" y="0" width="1" height="1"><feFlood flood-color="#c22" result="a"/><feFlood flood-color="#2c2" result="b"/><feComposite in="a" in2="b" operator="arithmetic" k1="0" k2="0" k3="1" k4="0"/></filter>
<filter id="f12" x="0" y="0" width="1" height="1"><feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="3"/><feColorMatrix type="matrix" values="0 0 0 0 0.1  0 1.6 0 0 -0.2  0 0 0 0 0.1  0 0 0 0 1"/></filter>
<filter id="f13" x="0" y="0" width="1" height="1"><feTurbulence type="turbulence" baseFrequency="0.03" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="40" xChannelSelector="R" yChannelSelector="G"/></filter>
<filter id="f14" x="-0.5" y="-0.5" width="2" height="2"><feGaussianBlur stdDeviation="14"/></filter>
<filter id="f15" filterUnits="userSpaceOnUse" x="0" y="0" width="180" height="180"><feMorphology operator="dilate" radius="12"/></filter>
<filter id="f23" x="0" y="0" width="1" height="1"><feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2"><animate attributeName="baseFrequency" values="0.02;0.06;0.02" dur="4s" repeatCount="indefinite"/></feTurbulence><feColorMatrix type="matrix" values="0 0 0 0 0.1  0 1.6 0 0 -0.2  0 0 0 0 0.1  0 0 0 0 1"/></filter>
</defs>`

const style = `<style>.ok{fill:#2c2}.bl{mix-blend-mode:difference}@keyframes bk{0%,49%{fill:#2c2}50%,100%{fill:#25c}}.ck{animation:bk 2s infinite}</style>`

const stripes = Array.from({ length: 9 }, (_, i) => `<rect x="${i * 20}" width="10" height="180" fill="#2c2"/>`).join('')

const tiles = [
  full('fill="#2c2"'), // 1 control
  full('fill="url(#lg)"'), // 2 linear gradient
  full('fill="url(#rg)"'), // 3 radial gradient
  full('fill="url(#pt)"'), // 4 pattern
  '<use href="#us"/>', // 5 use
  `<rect width="400" height="400" fill="#2c2" clip-path="url(#cp)"/>`, // 6 clipPath
  full('fill="#2c2" mask="url(#mk)"'), // 7 mask
  full('fill="#c22" filter="url(#f8)"'), // 8 feFlood
  full('fill="#c22" filter="url(#f9)"'), // 9 feColorMatrix
  full('fill="#c22" filter="url(#f10)"'), // 10 feComponentTransfer table
  full('fill="#c22" filter="url(#f11)"'), // 11 feComposite arithmetic
  full('fill="#000" filter="url(#f12)"'), // 12 feTurbulence
  `<g filter="url(#f13)"><rect width="180" height="180" fill="#123"/>${stripes}</g>`, // 13 feDisplacementMap
  `<rect width="180" height="180" fill="#123"/><circle cx="90" cy="90" r="40" fill="#2c2" filter="url(#f14)"/>`, // 14 blur
  `<rect width="180" height="180" fill="#123"/><rect x="88" y="20" width="4" height="140" fill="#2c2" filter="url(#f15)"/>`, // 15 morphology
  full('class="ok" fill-opacity="1"'), // 16 CSS class (black if <style> is ignored)
  `<rect width="180" height="180" fill="#f0f"/><rect width="180" height="180" fill="#fff" class="bl"/>`, // 17 blend mode
  `<rect width="180" height="180" fill="#123"/><text x="20" y="130" font-family="serif" font-size="110" fill="#2c2">Aa</text>`, // 18 text
  '<rect width="180" height="180" fill="#c22"><set attributeName="fill" to="#2c2" begin="0.3s"/></rect>', // 19 SMIL set
  '<rect width="180" height="180" fill="#2c2"><animate attributeName="fill" values="#2c2;#25c" calcMode="discrete" dur="2s" repeatCount="indefinite"/></rect>', // 20 SMIL blink
  full('class="ck"'), // 21 CSS animation blink
  `<rect width="180" height="180" fill="#123"/><path fill="#2c2" d="M40 40h100v100h-100z"><animate attributeName="d" values="M40 40h100v100h-100z;M90 20l70 70l-70 70l-70-70z;M40 40h100v100h-100z" dur="3s" repeatCount="indefinite"/></path>`, // 22 path morph
  full('fill="#000" filter="url(#f23)"'), // 23 animated turbulence
  `<rect width="180" height="180" fill="#123"/><rect x="85" y="20" width="10" height="140" fill="#2c2"><animateTransform attributeName="transform" type="rotate" from="0 90 90" to="360 90 90" dur="4s" repeatCount="indefinite"/></rect>`, // 24 rotate
]

export const CENSUS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid meet">` +
  `<rect width="1200" height="800" fill="#111"/>${style}${defs}${tiles.map((b, k) => tile(k, b)).join('')}</svg>`

export const CENSUS_LEGEND = [
  'Each tile starts red; green means the feature works.',
  '1 control · 2 linear gradient · 3 radial gradient · 4 pattern (green checks) · 5 <use> · 6 clipPath · 7 mask',
  '8 feFlood · 9 feColorMatrix · 10 feComponentTransfer · 11 feComposite arithmetic',
  '12 feTurbulence (green clouds) · 13 feDisplacementMap (wavy stripes; straight = no) · 14 blur (soft dot) · 15 morphology (thick bar; thin = no)',
  '16 CSS class (black = <style> ignored) · 17 blend mode (white = no) · 18 text ("Aa")',
  '19 SMIL set · 20 SMIL blink (green/blue) · 21 CSS animation blink · 22 shape morph (square <-> diamond) · 23 moving clouds · 24 spinning bar',
].join('\n')
