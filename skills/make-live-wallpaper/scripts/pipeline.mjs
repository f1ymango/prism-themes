// pipeline.mjs: a wallpaper (video or still picture) -> a Prism live keyframe theme, as stages you can check, correct
// and rerun one at a time.
//
//   node pipeline.mjs new <wallpaper> <id> [--out <dir>] [options]   make a project folder (runs nothing)
//   node pipeline.mjs run <dir> [--to <stage>] [--from <stage>] [options]
//                                     run the stages that are not done or whose inputs changed (up to theme)
//   node pipeline.mjs status <dir>    what each stage decided, and what to do next
//   node pipeline.mjs install <dir> [--force]   copy the theme into ~/.claude/prism-themes (backs up what it replaces)
//
// Options (remembered in <dir>/pipeline.json; changing one reruns the stages that use it and everything after):
//   --name "<Theme name>"   --loop <seconds>|auto|whole   --max <seconds to read, 40>   --motion-words <n, 1008>
//   --motion-v1 on|off      --quick on|off (encode fast with a fixed quantiser, for checking; off for the real thing)
//   --layers auto|off|mask  (auto: find parts that move over what is behind them; mask: use work/layers/mask.png as
//                            painted by hand)
//   --light auto|off        (auto: add a brightness term for light the motion cannot draw, when it pays for its words)
//
// Stages: probe -> keyframe -> frames -> loop -> motion -> layers -> light -> encode -> theme   (then install, only
// when asked)
// Each writes its files under <dir>/work, its log to <dir>/logs/<stage>.log, and a section of <dir>/REPORT.md with
// pictures in <dir>/report/ to check by eye. A still picture skips frames, loop and motion (it gets no motion).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync, createWriteStream, unlinkSync } from 'node:fs'
import { join, resolve, dirname, extname, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { writePNG } from './png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const STAGES = ['probe', 'keyframe', 'frames', 'loop', 'motion', 'layers', 'light', 'encode', 'theme']
const DEFAULTS = { name: null, loop: 'auto', max: 40, 'motion-words': 1008, 'motion-v1': 'off', layers: 'auto', light: 'auto', quick: 'off' }
const MW = 320, MH = 190, FPS = 12, S = MW * MH
const CROP = "crop='min(iw,ih*800/475)':'min(ih,iw*475/800)'"

class Problem extends Error { constructor(msg, hint) { super(msg); this.hint = hint } }

// --- command line ------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2), cmd = argv.shift()
const flags = {}, pos = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) flags[k] = 'on'; else { flags[k] = v; i++ } }
  else pos.push(argv[i])
}
const USAGE = 'usage: node pipeline.mjs new <wallpaper> <id> [--out dir] | run <dir> | status <dir> | install <dir>  (see the top of pipeline.mjs)'

// --- tools -------------------------------------------------------------------------------------------------------
function findTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const env = process.env[name.toUpperCase()]
  if (env) return env
  if (spawnSync(name, ['-version']).status === 0) return name
  const pk = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
  if (pk && existsSync(pk)) for (const d of readdirSync(pk).filter(d => /^Gyan\.FFmpeg/i.test(d))) {
    for (const b of readdirSync(join(pk, d))) { const p = join(pk, d, b, 'bin', exe); if (existsSync(p)) return p }
  }
  throw new Problem(`${name} was not found.`, `Install ffmpeg (Windows: winget install Gyan.FFmpeg; macOS: brew install ffmpeg), or set ${name.toUpperCase()} to the full path of ${exe}, then run the same command again.`)
}
let FF, FP
const tools = () => { FF ??= findTool('ffmpeg'); FP ??= findTool('ffprobe') }
// runs a program; its output goes to the stage log (and the console, when shown); returns the output text
function runLogged(log, file, args, opts = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(file, args, { env: { ...process.env, ...(opts.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    const take = d => { const s = String(d); text += s; log.write(s); if (opts.show) process.stdout.write(s) }
    p.stdout.on('data', take); p.stderr.on('data', take)
    p.on('error', e => fail(e))
    p.on('close', code => (code === 0 ? ok(text) : fail(new Problem(`${opts.what ?? basename(file)} stopped with an error (exit code ${code}).`, `The end of logs/${opts.stage}.log says why:\n${text.trim().split('\n').slice(-6).join('\n')}`))))
  })
}
const nodeScript = (log, script, args, opts = {}) => runLogged(log, process.execPath, [join(here, script), ...args], { what: script, ...opts })

// --- project state -----------------------------------------------------------------------------------------------
const statePath = dir => join(dir, 'pipeline.json')
function load(dir) {
  if (!dir || !existsSync(statePath(dir))) throw new Problem(`${dir ?? '(no folder given)'} is not a pipeline project folder.`, 'Make one first: node pipeline.mjs new <wallpaper> <id>')
  return JSON.parse(readFileSync(statePath(dir), 'utf8'))
}
const save = (dir, st) => writeFileSync(statePath(dir), JSON.stringify(st, null, 2) + '\n')
const hash = v => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12)

// What each stage reads: the options it uses and the stages before it. A stage is stale when this changes.
const USES = { probe: [], keyframe: [], frames: ['max'], loop: ['loop'], motion: ['motion-words', 'motion-v1'], layers: ['layers', 'motion-words'], light: ['light'], encode: ['quick'], theme: ['name'] }
const UP = { probe: [], keyframe: ['probe'], frames: ['probe'], loop: ['frames'], motion: ['loop'], layers: ['keyframe', 'motion'], light: ['motion', 'layers'], encode: ['keyframe', 'motion', 'layers', 'light'], theme: ['encode'] }
function fingerprint(st, s) {
  const inputStamp = st.input && existsSync(st.input) ? statSync(st.input).mtimeMs + ':' + statSync(st.input).size : 'missing'
  const maskP = join(st.dir, 'work', 'layers', 'mask.png')
  const maskStamp = s === 'layers' && st.options.layers === 'mask' ? (existsSync(maskP) ? statSync(maskP).mtimeMs + ':' + statSync(maskP).size : 'missing') : undefined
  return hash({ s, v: 1, input: s === 'probe' ? inputStamp : maskStamp, opts: USES[s].map(k => st.options[k]), up: UP[s].map(u => st.stages[u]?.fp ?? null) })
}

// --- the stages ----------------------------------------------------------------------------------------------------
// Each gets (st, ctx) and returns { summary: [lines for the report], images: [report/... files], facts: {...} }.
const W = (st, f) => join(st.dir, 'work', f)
const R = (st, f) => join(st.dir, 'report', f)
const facts = st => st.stages.probe?.facts ?? {}
const isStill = st => facts(st).still

const run = {
  async probe(st, { log }) {
    tools()
    let p
    try { p = JSON.parse(await runLogged(log, FP, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', st.input], { what: 'ffprobe', stage: 'probe' })) }
    catch (e) { throw new Problem(`ffmpeg cannot read ${basename(st.input)}: it is damaged, not finished downloading, or not a video or picture.`, `Check that the file plays in a video player. ffprobe said:\n${(e.hint ?? e.message).split('\n').slice(1).join('\n')}`) }
    const vs = p.streams.find(s => s.codec_type === 'video')
    if (!vs) throw new Problem(`${basename(st.input)} has no picture in it.`, 'Give a video (.mp4, .webm, .mov) or a picture (.png, .jpg, .webp).')
    const frames = +(vs.nb_frames ?? 0), dur = +(p.format.duration ?? vs.duration ?? 0)
    const still = (/^(png|mjpeg|bmp|webp|tiff|gif)$/.test(vs.codec_name) && (frames <= 1 || !dur)) || !(dur > 0.5)
    const aspect = vs.width / vs.height, off = Math.abs(aspect - 800 / 475) > 0.15
    const summary = [`${basename(st.input)}: ${vs.width} x ${vs.height}, ${vs.codec_name}, ${still ? 'a still picture (no motion)' : `${dur.toFixed(2)} s of video`}`]
    if (off) summary.push(`Not window-shaped (${aspect.toFixed(2)}:1, the window is 1.68:1): the centre is cropped. If the subject is off-centre, crop the wallpaper yourself first.`)
    if (!still && dur > st.options.max) summary.push(`Only the first ${st.options.max} s will be read (--max).`)
    if (Math.min(vs.width, vs.height * 800 / 475) < 1280) summary.push(`Smaller than the 1920 x 1140 keyframe, so it is scaled up and will look soft.`)
    return { summary, facts: { width: vs.width, height: vs.height, codec: vs.codec_name, dur, still } }
  },

  async keyframe(st, { log }) {
    tools()
    await runLogged(log, FF, ['-v', 'error', '-y', '-i', st.input, '-vf', `${CROP},scale=1920:1140:flags=lanczos`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', W(st, 'ref.rgb')], { what: 'ffmpeg (keyframe)', stage: 'keyframe' })
    const ref = readFileSync(W(st, 'ref.rgb')), t = new Uint8Array(640 * 380 * 3)
    for (let y = 0; y < 380; y++) for (let x = 0; x < 640; x++) for (let c = 0; c < 3; c++) t[(y * 640 + x) * 3 + c] = ref[((y * 3) * 1920 + x * 3) * 3 + c]
    writePNG(R(st, 'keyframe.png'), 640, 380, t)
    return { summary: ['The first frame, cropped to the window and scaled to 1920 x 1140: this is the picture that will be encoded.'], images: ['keyframe.png'] }
  },

  async frames(st, { log }) {
    if (isStill(st)) return { summary: ['A still picture: no motion frames.'], skipped: true }
    tools()
    const take = Math.min(facts(st).dur, +st.options.max)
    await runLogged(log, FF, ['-v', 'error', '-y', '-i', st.input, '-t', String(take), '-vf', `fps=${FPS},${CROP},scale=${MW}:${MH}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'gray', W(st, 'mot.gray')], { what: 'ffmpeg (motion frames)', stage: 'frames' })
    const N = Math.floor(statSync(W(st, 'mot.gray')).size / S)
    return { summary: [`${N} frames (${(N / FPS).toFixed(2)} s at ${FPS} fps), ${MW} x ${MH} grey, for the motion fit.`], facts: { N } }
  },

  async loop(st, { log }) {
    if (isStill(st)) return { summary: ['A still picture: no loop.'], skipped: true, facts: { loopS: 8 } }
    const raw = readFileSync(W(st, 'mot.gray')), N = Math.floor(raw.length / S), opt = String(st.options.loop)
    const mad = (a, b) => { let s = 0; for (let i = 0; i < S; i += 7) s += Math.abs(raw[a * S + i] - raw[b * S + i]); return s / Math.ceil(S / 7) }
    let P = N, how
    if (opt === 'auto') {
      // the shortest period (2 s or more) whose frames repeat about as well as the best period: a deep dip against the
      // typical (median) difference; of the dips, the shortest near the deepest
      const score = []
      for (let p = 2 * FPS; p <= N - FPS; p++) { let s = 0, n = 0; for (let f = 0; f + p < N; f += 2) { s += mad(f, f + p); n++ } score[p] = s / n }
      const all = score.filter(v => v !== undefined).sort((a, b) => a - b), med = all[Math.floor(all.length / 2)] ?? 0
      const dips = score.map((v, p) => (v !== undefined && v < 0.35 * med ? p : -1)).filter(p => p > 0)
      const best = Math.min(...dips.map(p => score[p]))
      const p = dips.find(p => score[p] <= best * 1.3 + 0.05) ?? -1
      if (p > 0) { P = p; how = `found automatically: the frames repeat every ${(P / FPS).toFixed(2)} s (difference ${score[p].toFixed(2)} against a typical ${med.toFixed(2)})` }
      else how = `no shorter repeat found, so the whole ${(N / FPS).toFixed(2)} s is the loop (wallpapers usually loop seamlessly end to start)`
      log.write(`period scores: ${score.map((v, p) => (v === undefined ? '' : `${p}:${v.toFixed(2)}`)).filter(Boolean).join(' ')}\n`)
    } else if (opt === 'whole') how = `the whole ${(N / FPS).toFixed(2)} s, as asked (--loop whole)`
    else { P = Math.max(FPS, Math.min(N, Math.round(+opt * FPS))); how = `${(P / FPS).toFixed(2)} s, as asked (--loop ${opt})` }
    writeFileSync(W(st, 'loop.gray'), raw.subarray(0, P * S))
    // the seam: the loop's last frame, its first, and their difference x4; a good loop shows a near-black third panel
    const seam = new Uint8Array(MW * 3 * MH * 3), a = (P - 1) * S, seamErr = mad(P - 1, 0) // last -> first is one frame step
    let step = 0; for (let f = 1; f < Math.min(P, 30); f++) step += mad(f - 1, f); step /= Math.min(P, 30) - 1
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
      const l = raw[a + y * MW + x], f0 = raw[y * MW + x], d = Math.min(255, Math.abs(l - f0) * 4)
      for (const [k, v] of [[0, l], [1, f0], [2, d]]) seam.fill(v, (y * MW * 3 + k * MW + x) * 3, (y * MW * 3 + k * MW + x) * 3 + 3)
    }
    writePNG(R(st, 'loop-seam.png'), MW * 3, MH, seam)
    const summary = [`Loop: ${how}.`, `Seam: the jump from the last frame back to the first is ${seamErr.toFixed(2)}, against ${step.toFixed(2)} for an ordinary frame step${seamErr > 3 * step + 1 ? ' — a visible jump. Try --loop whole, or another --loop length.' : ' — smooth.'}`]
    return { summary, images: ['loop-seam.png'], facts: { P, loopS: P / FPS, seamErr, step } }
  },

  async motion(st, { log }) {
    const packP = W(st, 'pack.json')
    if (isStill(st)) {
      writeFileSync(packP, JSON.stringify({ GX: 24, GY: 14, W: MW, H: MH, harmonics: 3, bits: 6, gamma: 1, loopMs: 8000, scale: [0, 0, 0], ints: Array.from({ length: 24 * 14 }, () => [0, 0, 0]) }))
      return { summary: ['A still picture: no motion is stored.'], skipped: true }
    }
    const { P } = st.stages.loop.facts, one = readFileSync(W(st, 'loop.gray')), loopP = W(st, 'loop.gray'), motP = W(st, 'mot.json')
    // where the picture moves: temporal std per pixel
    const mu = new Float64Array(S), sq = new Float64Array(S)
    for (let f = 0; f < P; f++) for (let i = 0; i < S; i++) { const v = one[f * S + i]; mu[i] += v; sq[i] += v * v }
    const sd = Float32Array.from(mu, (m, i) => Math.sqrt(Math.max(0, sq[i] / P - (m / P) ** 2)))
    let mov = 0, still = 0; for (const v of sd) if (v > 4) mov++
    for (let f = 1; f < P; f++) for (let i = 0; i < S; i++) if (sd[i] > 4) still += Math.abs(one[f * S + i] - one[i])
    still /= Math.max(1, mov * (P - 1))
    const map = new Uint8Array(S * 3)
    for (let i = 0; i < S; i++) { const g = one[i] * 0.5, t = Math.min(1, sd[i] / 16); map[i * 3] = g + t * (255 - g); map[i * 3 + 1] = g * (1 - t) + t * 120; map[i * 3 + 2] = g * (1 - t) }
    writePNG(R(st, 'motion-map.png'), MW, MH, map)
    await nodeScript(log, 'flow2.mjs', [loopP, String(MW), String(MH), motP, '24', '14'], { stage: 'motion' })
    let line
    if (st.options['motion-v1'] === 'on') {
      await nodeScript(log, 'quant.mjs', [motP, W(st, 'mot-q.json'), '3', '6', '1', packP], { stage: 'motion', env: { P: String(P), FPS: String(FPS) } })
      line = 'Motion v1 (3 harmonics), as asked.'
    } else {
      if (mov / S < 0.35) await nodeScript(log, 'flow2.mjs', [loopP, String(MW), String(MH), motP.replace(/\.json$/, '.48.json'), '48', '28'], { stage: 'motion' })
      const out = await nodeScript(log, 'mv2.mjs', [motP, loopP, String(MW), String(MH), String(Math.round((P * 1000) / FPS)), packP, String(st.options['motion-words'])], { stage: 'motion' })
      line = (out.match(/motion v2: [^\n]*/) ?? ['motion v2 fitted'])[0]
    }
    return { summary: [`${((100 * mov) / S).toFixed(1)}% of the picture moves (orange in the map).`, line[0].toUpperCase() + line.slice(1) + '.', `Moving error: the average grey-level error left on moving pixels when the motion is played; with no motion at all it would be ${still.toFixed(2)}. Content that appears rather than moves (a curtain opening, hair crossing) stays as error.`], images: ['motion-map.png'], facts: { moving: mov / S, stillErr: still } }
  },

  async layers(st, { log }) {
    const out = W(st, 'pack.layers.json'), mode = st.options.layers
    for (const f of [out, out.replace(/\.json$/, '.play.json')]) if (existsSync(f)) unlinkSync(f)
    if (isStill(st)) return { summary: ['A still picture: no layers.'], skipped: true, facts: { used: false } }
    if (mode === 'off' || st.options['motion-v1'] === 'on') return { summary: [mode === 'off' ? 'Layers off, as asked (--layers off): one motion field for the whole picture.' : 'Layers need motion v2 (--motion-v1 off).'], skipped: true, facts: { used: false } }
    tools()
    // two fields need more room than one: 1.5 x the motion words (a test wallpaper: moving error 9.2 at 1 x, 7.7 at 1.5 x, against
    // 7.5 for one field; each 1000 words cost the keyframe ~0.45 dB); the outline comes on top
    const args = [join(st.dir, 'work'), out, '--budget', String(Math.round(1.5 * st.options['motion-words'])), '--video', st.input, '--ffmpeg', FF]
    if (mode === 'mask') {
      const m = W(st, 'layers/mask.png')
      if (!existsSync(m)) throw new Problem('--layers mask uses work/layers/mask.png, and there is none yet.', 'Run with --layers auto first: it makes that file for you to correct.')
      args.push('--mask', m)
    }
    console.log(`  finding the parts that move on their own${mode === 'mask' ? ' (your mask)' : ': a few minutes'}...`)
    const text = await nodeScript(log, 'layers.mjs', args, { stage: 'layers' })
    const used = existsSync(out), say = text.split(/\r?\n/).filter(l => /^(part \d|dropped|no part|outline:|layered motion:|the two fields|.* has no parts)/.test(l))
    const images = []
    for (const [from, to] of [['overlay.png', 'layers.png'], ['compare.png', 'layers-compare.png']]) if (used && existsSync(W(st, 'layers/' + from))) { copyFileSync(W(st, 'layers/' + from), R(st, to)); images.push(to) }
    const summary = used
      ? [...say, "layers.png: each part tinted, its outline white; the rest of the picture keeps the background's motion. layers-compare.png: the frame where the parts move most, real | one field | layered (what is beside a part should stay straight in the third).", "To correct an outline: paint over work/layers/mask.png (black = background, a part's colour = that part; keep it 1280 x 760), then run with --layers mask."]
      : ['No layers: the one-field motion from the motion stage is used.', ...say.filter(l => !/^no layers/.test(l))]
    return { summary, images, facts: { used } }
  },

  async light(st, { log }) {
    const out = W(st, 'pack.light.json')
    for (const f of [out, out.replace(/.json$/, '.light-play.json')]) if (existsSync(f)) unlinkSync(f)
    if (isStill(st)) return { summary: ['A still picture: no light.'], skipped: true, facts: { used: false } }
    if (st.options.light === 'off') return { summary: ['Light off, as asked (--light off).'], skipped: true, facts: { used: false } }
    if (st.options['motion-v1'] === 'on') return { summary: ['The light term needs motion v2 (--motion-v1 off).'], skipped: true, facts: { used: false } }
    if (st.stages.layers?.facts?.used) return { summary: ['Layers are on: the light term works with one motion field only, so it is left out (--layers off to have it instead).'], skipped: true, facts: { used: false } }
    tools()
    const { P } = st.stages.loop.facts
    const text = await nodeScript(log, 'light.mjs', [W(st, 'pack.json'), W(st, 'loop.gray'), String(MW), String(MH), out, '400', R(st, 'light.png')], { stage: 'light' })
    const used = / kept$/m.test(text), line = (text.match(/^light: .*$/m) ?? ['light fitted'])[0]
    return {
      summary: [line[0].toUpperCase() + line.slice(1) + '.', 'light.png: the middle of the loop, real | motion only | motion and light. The light is a brightness change on a coarse grid (sweeping light, glare, shadows), for what a warp of the keyframe cannot draw.'],
      images: existsSync(R(st, 'light.png')) ? ['light.png'] : [], facts: { used, frames: P },
    }
  },

  async encode(st, { log }) {
    const svgP = join(st.dir, 'live', `${st.id}-key.svg`), pngP = join(st.dir, 'preview.png'), quick = st.options.quick === 'on'
    console.log(`  encoding the keyframe${quick ? ' (quick)' : ': a few minutes (longer on a machine with few cores)'}...`)
    const pack = st.stages.light?.facts?.used ? W(st, 'pack.light.json') : st.stages.layers?.facts?.used ? W(st, 'pack.layers.json') : W(st, 'pack.json')
    const out = await nodeScript(log, 'ka2-enc.mjs', [W(st, 'ref.rgb'), '1920', '1140', pack, svgP, pngP], { stage: 'encode', env: { CAP: '255', QTAB: join(here, 'q20-14.json'), ...(quick ? { FIXS: '1.8' } : {}) } })
    const m = out.match(/decode mismatches (\d+), PSNR ([\d.]+) dB/)
    if (!m) throw new Problem('The encoder finished without its final check line.', 'See logs/encode.log.')
    if (+m[1] !== 0) throw new Problem(`The encoded keyframe does not decode exactly (${m[1]} mismatches): the file would draw wrongly.`, 'This is a codec bug, not something an option fixes. Keep logs/encode.log and work/ for whoever looks at it.')
    const p = readFileSync(pngP + '.rgb'), t = new Uint8Array(640 * 380 * 3)
    for (let y = 0; y < 380; y++) for (let x = 0; x < 640; x++) for (let c = 0; c < 3; c++) t[(y * 640 + x) * 3 + c] = p[((y * 3) * 1920 + x * 3) * 3 + c]
    writePNG(R(st, 'decoded.png'), 640, 380, t)
    return { summary: [`Encoded${quick ? ' quickly (--quick on: for checking only; run with --quick off for the real theme)' : ''}: ${(statSync(svgP).size / 1e6).toFixed(2)} MB, ${(+m[2]).toFixed(2)} dB against the keyframe, decodes exactly.`, 'decoded.png is what Desktop will show (full size: preview.png). Compare it with keyframe.png.'], images: ['decoded.png'], facts: { psnr: +m[2], quick } }
  },

  async theme(st) {
    // palette from the decoded keyframe: background from the darkest/lightest quarter, accent from the most colourful
    const fin = readFileSync(join(st.dir, 'preview.png.rgb'))
    const px = []; for (let i = 0; i < fin.length; i += 3 * 37) px.push([fin[i], fin[i + 1], fin[i + 2]])
    const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], sat = c => Math.max(...c) - Math.min(...c)
    const avg = a => [0, 1, 2].map(k => a.reduce((s, c) => s + c[k], 0) / a.length)
    const hex = c => '#' + c.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')
    const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t)
    const byL = [...px].sort((a, b) => lum(a) - lum(b)), q = Math.floor(px.length / 4)
    const dark = avg(byL.slice(0, q)), light = avg(byL.slice(-q))
    const vivid = avg([...px].sort((a, b) => sat(b) - sat(a)).slice(0, Math.max(1, Math.floor(px.length / 20))))
    const accentD = lum(vivid) < 110 ? mix(vivid, [255, 255, 255], 0.35) : vivid, accentL = lum(vivid) > 120 ? mix(vivid, [0, 0, 0], 0.4) : vivid
    const bgFile = `${st.id}${extname(st.input).toLowerCase()}`
    copyFileSync(st.input, join(st.dir, 'themes', bgFile))
    const name = st.options.name ?? st.id.replace(/(^|-)(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase())
    const theme = {
      schema: 2, id: st.id, name, tagline: 'Live wallpaper',
      palette: { light: { bg: hex(mix(light, [255, 255, 255], 0.7)), text: '#1c1c1e', accent: hex(accentL) }, dark: { bg: hex(mix(dark, [0, 0, 0], 0.55)), text: '#ececee', accent: hex(accentD) } },
      background: { file: bgFile, fit: 'cover', dim: 0.4 },
      panels: 'glass',
    }
    writeFileSync(join(st.dir, 'themes', `${st.id}.json`), JSON.stringify(theme, null, 2) + '\n')
    const loopS = st.stages.loop?.facts?.loopS ?? 8
    writeFileSync(join(st.dir, 'INSTALL.txt'), `${name}: a live wallpaper theme for Prism (Claude Desktop)

1. Install Prism: in Claude Desktop, add the prism-themes plugin (see its README).
2. Copy the two folders here into your Prism folder, %USERPROFILE%\\.claude\\prism-themes\\ (macOS: ~/.claude/prism-themes/)
     live\\${st.id}-key.svg    -> ...\\prism-themes\\live\\
     themes\\${st.id}.json and themes\\${bgFile}    -> ...\\prism-themes\\themes\\
   (or, with this pipeline: node pipeline.mjs install <this folder>)
3. Windows: Settings > Personalization > Colors > Transparency effects: On.
   Windows: Settings > Accessibility > Visual effects > Animation effects: On (Claude's Motion setting: System).
4. Quit Claude Desktop fully (right-click the tray icon > Quit), start it again, and pick the theme with /prism use ${st.id}.

What to expect: a blurred preview appears within a second, the sharp picture draws in a few seconds later, then it
moves (a ${loopS.toFixed(1)} s loop). If you restart Desktop quickly, the wallpaper can take up to about 5 minutes to
come back: Claude Desktop pauses wallpapers for a while after an unclean stop, and Prism redraws it when that ends.
/prism startlog shows what happened at start-up, if something looks wrong.
`)
    const sw = c => `\`${c}\``
    return { summary: [`Theme "${name}" (${st.id}): dark ${sw(theme.palette.dark.bg)} / accent ${sw(theme.palette.dark.accent)}, light ${sw(theme.palette.light.bg)} / accent ${sw(theme.palette.light.accent)}.`, `The wallpaper itself is copied as the theme's plain background (shown where the live keyframe cannot run). INSTALL.txt says how to install by hand.`] }
  },
}

// --- report ------------------------------------------------------------------------------------------------------
const TITLES = { probe: 'Probe: what the file is', keyframe: 'Keyframe: the picture', frames: 'Frames: motion samples', loop: 'Loop: how long one cycle is', motion: 'Motion: what moves and how', layers: 'Layers: parts that move on their own', light: 'Light: brightness changes', encode: 'Encode: the keyframe codec', theme: 'Theme: colours and files', install: 'Install' }
function writeReport(st) {
  const L = [`# ${st.options.name ?? st.id}: conversion report`, '', `Wallpaper: \`${st.input}\`  `, `Options: ${Object.entries(st.options).map(([k, v]) => `${k} ${v ?? '(default)'}`).join(', ')}`, '']
  for (const s of [...STAGES, 'install']) {
    const r = st.stages[s]; if (!r) { if (s !== 'install') L.push(`## ${TITLES[s]}`, '', '_Not run yet._', ''); continue }
    L.push(`## ${TITLES[s]}`, '')
    if (r.status === 'failed') L.push(`**Failed:** ${r.error}`, '', r.hint ? `What to do: ${r.hint}` : '', '')
    else { for (const l of r.summary ?? []) L.push(`- ${l}`); for (const i of r.images ?? []) L.push('', `![${i}](report/${i})`); L.push('', `_${r.status}${r.secs != null ? `, ${r.secs < 90 ? r.secs.toFixed(0) + ' s' : (r.secs / 60).toFixed(1) + ' min'}` : ''}; log: logs/${s}.log_`, '') }
  }
  writeFileSync(join(st.dir, 'REPORT.md'), L.join('\n'))
}

function status(st, why) {
  const lines = []
  for (const s of STAGES) {
    const r = st.stages[s], stale = r && r.status === 'done' && r.fp !== fingerprint(st, s)
    const mark = !r ? 'not run' : r.status === 'failed' ? 'FAILED' : stale ? 'needs rerun (its inputs changed)' : r.skipped ? 'skipped' : 'done'
    lines.push(`  ${s.padEnd(9)} ${mark}${r?.status === 'done' && !stale && r.summary?.[0] ? ': ' + r.summary[0] : ''}${r?.status === 'failed' ? ': ' + r.error : ''}`)
  }
  if (st.stages.install) lines.push(`  ${'install'.padEnd(9)} ${st.stages.install.status}: ${st.stages.install.summary?.[0] ?? st.stages.install.error ?? ''}`)
  const failed = STAGES.find(s => st.stages[s]?.status === 'failed'), todo = STAGES.find(s => !st.stages[s] || st.stages[s].fp !== fingerprint(st, s))
  const next = failed ? `fix what the ${failed} stage says (REPORT.md), then: node pipeline.mjs run ${st.dir}` : todo ? `node pipeline.mjs run ${st.dir}` : st.stages.install?.status === 'done' ? `in Claude Desktop: quit fully, restart, then /prism use ${st.id}` : `check REPORT.md, then: node pipeline.mjs install ${st.dir}`
  console.log(`${why ?? 'status'} of ${st.dir}\n${lines.join('\n')}\nnext: ${next}`)
}

// --- install -----------------------------------------------------------------------------------------------------
function install(st, force) {
  if (STAGES.some(s => st.stages[s]?.status !== 'done' || st.stages[s].fp !== fingerprint(st, s))) throw new Problem('The theme is not finished yet.', `Run the stages first: node pipeline.mjs run ${st.dir}`)
  if (st.stages.encode.facts?.quick && !force) throw new Problem('This keyframe was encoded with --quick on (a check copy, visibly worse).', `Rerun with --quick off for the real one (node pipeline.mjs run ${st.dir} --quick off), or install it anyway with --force.`)
  const home = process.env.PRISM_HOME ?? join(homedir(), '.claude', 'prism-themes')
  if (!existsSync(home)) throw new Problem(`Prism's folder ${home} does not exist yet.`, 'Install the prism-themes plugin in Claude Desktop and open /prism once (that makes the folder), then run install again.')
  const bgFile = JSON.parse(readFileSync(join(st.dir, 'themes', `${st.id}.json`), 'utf8')).background.file
  const files = [['live', `${st.id}-key.svg`], ['themes', `${st.id}.json`], ['themes', bgFile]]
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19), lines = []
  for (const [d, f] of files) {
    mkdirSync(join(home, d), { recursive: true })
    const to = join(home, d, f)
    const same = existsSync(to) && statSync(to).size === statSync(join(st.dir, d, f)).size && hash(readFileSync(to).toString('base64')) === hash(readFileSync(join(st.dir, d, f)).toString('base64'))
    if (same) { lines.push(`${d}/${f} was already there, unchanged`); continue }
    if (existsSync(to)) { const bak = `${to}.bak-${stamp}`; copyFileSync(to, bak); lines.push(`kept the old ${d}/${f} as ${basename(bak)}`) }
    copyFileSync(join(st.dir, d, f), to)
  }
  const copied = files.filter(([d, f]) => !lines.includes(`${d}/${f} was already there, unchanged`)).map(([d, f]) => `${d}/${f}`)
  return { summary: [copied.length ? `Copied into ${home}: ${copied.join(', ')}.` : `Nothing to copy: ${home} already has this theme.`, ...lines, `Now in Claude Desktop: Windows needs Transparency effects and Animation effects on (Settings); quit Desktop fully, start it again, and type /prism use ${st.id}.`] }
}

// --- main --------------------------------------------------------------------------------------------------------
async function runStage(st, s) {
  mkdirSync(join(st.dir, 'logs'), { recursive: true })
  const log = createWriteStream(join(st.dir, 'logs', `${s}.log`))
  const t0 = Date.now()
  process.stdout.write(`${s}...\n`)
  try {
    const r = await run[s](st, { log })
    st.stages[s] = { status: 'done', fp: fingerprint(st, s), secs: (Date.now() - t0) / 1000, at: new Date().toISOString(), ...r }
    for (const l of r.summary ?? []) console.log(`  ${l}`)
  } catch (e) {
    st.stages[s] = { status: 'failed', fp: null, error: e.message, hint: e.hint ?? (e instanceof Problem ? undefined : 'An unexpected error; logs/' + s + '.log and the message above say more.'), at: new Date().toISOString() }
    if (!(e instanceof Problem)) log.write(String(e.stack))
    throw e
  } finally { log.end(); save(st.dir, st); writeReport(st) }
}

async function main() {
  if (cmd === 'new') {
    const [input, id] = pos
    if (!input || !id) throw new Problem('new needs a wallpaper file and an id.', USAGE)
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Problem(`"${id}" cannot be an id.`, 'Use lower-case letters, digits and dashes (it names the theme and its files), e.g. rooftop-night.')
    if (!existsSync(input)) throw new Problem(`There is no file ${input}.`, 'Check the path; put it in quotes if it has spaces.')
    const dir = resolve(flags.out ?? `${id}-prism`)
    if (existsSync(statePath(dir))) throw new Problem(`${dir} is already a project.`, `Continue it with: node pipeline.mjs run ${dir}`)
    for (const d of ['work', 'live', 'themes', 'report', 'logs']) mkdirSync(join(dir, d), { recursive: true })
    const st = { id, input: resolve(input), dir, options: { ...DEFAULTS }, stages: {} }
    setOptions(st)
    save(dir, st); writeReport(st)
    console.log(`made ${dir}\nnext: node pipeline.mjs run ${dir}   (or --to motion first, to check the loop and motion before the long encode)`)
    return
  }
  if (cmd === 'run') {
    const st = load(resolve(pos[0] ?? '')); st.dir = resolve(pos[0])
    setOptions(st)
    const to = flags.to ?? 'theme', from = flags.from
    for (const k of [to, from]) if (k && !STAGES.includes(k)) throw new Problem(`There is no stage "${k}".`, `The stages are: ${STAGES.join(', ')}.`)
    if (from) for (const s of STAGES.slice(STAGES.indexOf(from))) delete st.stages[s]
    for (const s of STAGES.slice(0, STAGES.indexOf(to) + 1)) {
      const r = st.stages[s]
      if (r?.status === 'done' && r.fp === fingerprint(st, s)) { console.log(`${s}: up to date`); continue }
      await runStage(st, s)
    }
    save(st.dir, st); writeReport(st)
    status(st, 'done; status')
    return
  }
  if (cmd === 'status') { const st = load(resolve(pos[0] ?? '')); st.dir = resolve(pos[0]); status(st); return }
  if (cmd === 'install') {
    const st = load(resolve(pos[0] ?? '')); st.dir = resolve(pos[0])
    try { st.stages.install = { status: 'done', at: new Date().toISOString(), ...install(st, flags.force === 'on') } }
    catch (e) { st.stages.install = { status: 'failed', error: e.message, hint: e.hint }; save(st.dir, st); writeReport(st); throw e }
    save(st.dir, st); writeReport(st)
    for (const l of st.stages.install.summary) console.log(l)
    return
  }
  throw new Problem(cmd ? `Unknown command "${cmd}".` : 'No command given.', USAGE)
}
function setOptions(st) {
  for (const [k, v] of Object.entries(flags)) {
    if (['out', 'to', 'from', 'force'].includes(k)) continue
    if (!(k in DEFAULTS)) throw new Problem(`Unknown option --${k}.`, `Options: ${Object.keys(DEFAULTS).map(k => '--' + k).join(', ')}.`)
    if (k === 'loop' && !/^(auto|whole|\d+(\.\d+)?)$/.test(v)) throw new Problem(`--loop ${v} is not a loop length.`, 'Give seconds (e.g. 8 or 7.5), auto, or whole.')
    if ((k === 'max' || k === 'motion-words') && !(+v > 0)) throw new Problem(`--${k} needs a positive number.`, '')
    if ((k === 'quick' || k === 'motion-v1') && !['on', 'off'].includes(v)) throw new Problem(`--${k} is on or off.`, '')
    if (k === 'layers' && !['auto', 'off', 'mask'].includes(v)) throw new Problem(`--layers is auto, off or mask.`, '')
    if (k === 'light' && !['auto', 'off'].includes(v)) throw new Problem(`--light is auto or off.`, '')
    st.options[k] = k === 'max' || k === 'motion-words' ? +v : v
  }
}
main().catch(e => {
  console.error(`\nstopped: ${e.message}${e.hint ? `\nwhat to do: ${e.hint}` : ''}`)
  if (!(e instanceof Problem)) console.error(e.stack)
  process.exit(1)
})
