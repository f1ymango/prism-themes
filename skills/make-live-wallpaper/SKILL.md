---
name: make-live-wallpaper
description: Turn a wallpaper video or picture into a Prism live wallpaper (a moving keyframe drawn by the Prism Themes mod in Claude Desktop), check each step, fix what went wrong, and install it. Use when the person asks to convert, make or install a live / animated / Wallpaper Engine wallpaper for Prism, or asks why a converted wallpaper looks or moves wrong.
---

# Make a live wallpaper

The converter is a pipeline of stages. Each stage saves its files, writes a section of `REPORT.md` with pictures,
and can be corrected and rerun on its own. Run it, read the report with the person, fix the stage that missed,
then install. Do not promise a perfect result in one go: wallpapers differ, and the report is how you find out.

Scripts: the `scripts/` folder in this skill's base directory (below: `$S`; use the full path, quoted). Needs
Node 22+ and ffmpeg. Put the project folder somewhere the person chooses (default: beside the wallpaper), never
inside the plugin.

## 1. Check what is needed

- `node --version` (22 or newer).
- ffmpeg: the pipeline finds it on PATH or in winget's folder. If the probe stage says it is missing, offer to
  install it (`winget install Gyan.FFmpeg` on Windows, `brew install ffmpeg` on macOS) and wait for a yes.
- Ask for the wallpaper file if you do not have it, and for a short id (lower-case, dashes) and a display name.

## 2. Make the project and run up to layers

```
node $S/pipeline.mjs new "<wallpaper>" <id> --name "<Name>" --out "<folder>"
node $S/pipeline.mjs run "<folder>" --to layers
```

This takes a few minutes (most of it the layers stage). Stop here and read `REPORT.md` (and its pictures, with the
Read tool) before the encode, so a wrong loop, motion or outline is caught before the longest step.

## 3. Read the report and fix the stage that missed

| Stage | What to look at | If it is wrong |
|---|---|---|
| probe | size, length, "not window-shaped" | crop the source yourself (ffmpeg) if the subject is off-centre, then `new` again |
| keyframe | `report/keyframe.png`: the picture that will show | same as probe; the first frame is used, so trim the start (`ffmpeg -ss`) if it is a fade-in |
| loop | the length found; `report/loop-seam.png`: last frame, first frame, difference (should be near black) | `run <folder> --loop <seconds>` or `--loop whole` |
| motion | `report/motion-map.png` (orange = moves); moving error against the no-motion error | `--motion-words 1500` gives motion more room (the picture loses a little); content that appears instead of moving (a curtain opening) cannot be fixed by options |
| layers | `report/layers.png` (each part that moves on its own, tinted, outline white); `report/layers-compare.png` (real, one field, layered at the parts' largest move: what is beside a part should stay straight in the third) | an outline that misses part of the thing or takes in background: paint over `work/layers/mask.png` (black = background, the part's colour = the part, keep 1280 x 760; offer to do it with the person, or let them use any paint program), then `run <folder> --layers mask`. A part found where nothing should move on its own, or layers making it worse: `--layers off` |
| light | `report/light.png` (the middle of the loop: real, motion only, motion and light); the moving error with and without it | light is a brightness change on a coarse grid, for sweeping light, glare and shadows that a warp cannot draw; it is kept only when it pays for its words, and only with one motion field (layers on leave it out). If it looks wrong (a part flickering dark or bright): `--light off` |
| encode | `report/decoded.png` against `keyframe.png`; "decodes exactly" | a mismatch is a codec bug: stop, keep the folder, report it |
| theme | the colours | `run <folder> --name "..."`; colours can be changed in `themes/<id>.json` by hand |

Changing an option reruns only the stages that use it and the ones after. `node $S/pipeline.mjs status "<folder>"`
says where things stand and what to do next. A failed stage says why in plain words and names its log
(`logs/<stage>.log`); read the log before guessing.

## 4. Encode for real

```
node $S/pipeline.mjs run "<folder>"
```

The keyframe encode spreads over the machine's cores: about 3 minutes with 12 or more threads, up to a quarter of an
hour on one; run it in the background and tell the person. (`--quick on` encodes in under a minute at lower quality,
for checking only; install refuses a quick encode unless `--force`.)

## 5. Install, with the person's OK

Installing writes into the person's Prism folder, so ask first.

```
node $S/pipeline.mjs install "<folder>"
```

It copies the keyframe, theme and background into `~/.claude/prism-themes/`, keeping a dated backup of anything it
replaces. Then the person must, on Windows, have Transparency effects and Animation effects on (Settings), quit
Claude Desktop fully and start it again, and type `/prism use <id>`. The sharp picture draws a few seconds after a
blurred preview; after a quick restart it can take up to about 5 minutes (Desktop pauses wallpapers after an
unclean stop). If it still looks wrong, `/prism startlog` shows what happened at start-up. While visible, a live
wallpaper keeps the GPU busy (about half of an integrated GPU). `/prism motion off` holds it still and
`/prism motion on` brings the motion back; holding still does not lower the GPU cost.

## Rules

- Never edit the generated `live/<id>-key.svg` by hand: it is a codec stream and one wrong character breaks it.
- The wallpaper and everything made from it belong to the person; do not upload or share them.
