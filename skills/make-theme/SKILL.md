---
name: make-theme
description: Make a new Claude Desktop theme for the Prism Themes mod (schema 2) from a text idea, a reference image, a wallpaper file, or any mix. Use when the person asks to create, design or make a theme, colour scheme or background for Claude Desktop, or to change one of their own Prism themes. Drafts the theme as an Artifact for approval before writing it.
---

# Make a Prism theme

A theme is one JSON file, `<id>.json`, in the person's themes folder, with an optional stylesheet and picture or
video beside it:

- Windows: `%USERPROFILE%\.claude\prism-themes\themes\`
- macOS: `~/.claude/prism-themes/themes/`

Mod updates never touch this folder. The mod reads it whenever the person opens `/prism`, or runs `/prism reload`.

## 1. Find out what the person wants

Ask only what you cannot choose well yourself, using `AskUserQuestion`:

- **Colours only**: palette, font, corner shapes, status line.
- **With a background**: also a gradient, or one of their own files (a picture, an animated SVG, a video such as a
  Wallpaper Engine `.mp4`, or a folder of pictures for a slideshow).
- **Light and dark**: whether it should follow the app's light/dark setting (two palettes) or always look the same.

If they give an image, read it with the Read tool. Take a background colour, a text colour with strong contrast
against it (aim for WCAG AA, 4.5:1), and one accent colour. Take the mood and motifs too.

## 2. Draft it as an Artifact, and wait for a yes

Do not write into the themes folder before the person approves a draft.

1. Write the theme JSON in your scratchpad (fields below).
2. Build a small HTML page that previews it: a sidebar, two chat messages, a composer box, and a status line, painted
   with the palette, font and radii, over the background (a CSS gradient, or the person's picture). Load the
   artifact skills first, as the Artifact tool asks, and publish the page.
3. In your reply, name the colours you chose and why, and the contrast ratio of text on background.
4. Revise until the person says yes, publishing each version to the same Artifact.

## 3. Write it

1. Write `<id>.json` (and `<id>.css` if the theme has a stylesheet) to the themes folder. Create the folder if it
   does not exist.
2. A background file can stay where it is (use its absolute path in `background.file`), or be copied beside the
   theme (use its bare file name). Never copy large videos without asking.
3. Tell the person to open `/prism` and pick it under **Yours**, and that `/prism doctor` lists any problems with
   the file. A background needs the extension (`/prism` → **Install extension**).

## The theme file (schema 2)

```jsonc
{
  "schema": 2,                         // required
  "id": "koi-evening",                 // required: lowercase letters, digits, dashes; same as the file name
  "name": "Koi Evening",
  "tagline": "Still water at dusk",
  "extends": "dusk",                   // optional: start from another theme (built-in: dusk, harbor, parchment)
                                       // and override only the layers given here

  // one palette, or a light and a dark one (the page then follows the app's light/dark setting)
  "palette": { "bg": "#11332d", "text": "#e4f2ea", "accent": "#ef8a4a" },
  // "palette": { "light": { "bg": ..., "text": ..., "accent": ... }, "dark": { ... } },

  "typography": { "font": "Georgia, 'Times New Roman', serif" },
  "shape": { "radius": 10, "composerRadius": 20 },          // pixels, 0–40

  // a gradient, or a file (relative to this file, or absolute)
  "background": { "gradient": { "angle": 160, "stops": ["#1b1430", "#7a3d5c", "#c0645a"] } },
  // "background": { "file": "koi.mp4", "fit": "cover", "dim": 0.3, "interval": 60 },

  "panels": "glass",                   // side panels over the background: glass, clear or solid
  "status": { "idle": "◌", "tool": "◌ {tool}…", "error": "◌ {tool} failed", "done": "◎ done" },
  "css": "koi-evening.css"             // optional stylesheet beside the theme
}
```

Rules for the stylesheet (`css`): nothing may load from outside the page. No `@import`, no `url()` except `data:`,
no backslash escapes. The mod refuses a stylesheet that breaks these. It can react to what Claude is doing through
attributes on `<html>`:

- `data-tfc-event` is `tool`, `error` or `done` for about a second; `data-tfc-tool` names the tool
- `data-tfc-state` is `thinking` or `waiting` (a permission question has waited over 1.5 s)
- `data-tfc-mode` is `light` or `dark`

Respect `prefers-reduced-motion` for anything that moves. Never target the app's own `data-theme` attribute.

Raw app variables (`"tokens": { "cds-...": "..." }`) are possible, but they stop working when the app renames them.
Prefer the palette, typography and shape layers.

## Selection rules (optional)

`rules.json` in the parent folder (`.claude\prism-themes\rules.json`) picks themes automatically. The first rule that
matches wins, and the person's own pick in `/prism` overrides rules for that session:

```json
[
  { "when": { "project": "C:/Projects/my-app*", "time": "19:00-07:00" }, "use": "harbor" },
  { "when": { "project": "C:/Projects/my-app*" }, "use": "parchment" },
  { "when": { "time": "22:00-06:00" }, "use": "dusk" }
]
```

`project` matches the session's folder and anything inside it (`*` is any run of characters). `time` is
`HH:MM-HH:MM`, 24-hour, and may span midnight. Use `"claude"` for the app's own look.
