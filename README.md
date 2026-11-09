# Prism Themes

Prism has two desktop integrations:

- **[ChatGPT/Codex on Windows](platforms/chatgpt-windows/README.md):** local image and looping video wallpapers, with matching translucent panels, accent colour, font and corner shape. This engineering preview is verified in the Codex view of the `OpenAI.Codex` Windows app.
- **Claude Desktop:** colours, fonts, corner shapes, and picture, slideshow or video backgrounds for the Code tab. Themes can follow light/dark mode, inherit from each other, and switch by project folder or time of day.

The integrations have different installation steps and theme formats. Wallpaper Engine `.mp4` files work in both.

A community mod, not made or endorsed by Anthropic or OpenAI. The Claude integration grew out of
[claude-desktop-themes](https://github.com/0toshigami/claude-desktop-themes) by 0toshigami, whose idea of painting
the app through its React DevTools extension slot it builds on.

> **Unofficial.** Both integrations use app internals that can change after an update. The Codex integration checks
> unfamiliar builds in an isolated profile; Claude Desktop's `/prism doctor` reports which drawing paths still work.

## Claude Desktop demos

| Afterschool Rain | Punklorde | Miku |
| :-: | :-: | :-: |
| <img src="docs/demo/afterschool-rain.gif" alt="Claude Desktop with a rainy anime street video behind the chat" width="320"> | <img src="docs/demo/punklorde.gif" alt="Claude Desktop with a neon cyberpunk city video behind the chat" width="320"> | <img src="docs/demo/miku.gif" alt="Claude Desktop with an animated Hatsune Miku close-up behind the chat" width="320"> |
| a video wallpaper, frosted panels | neon effects that react while Claude works | light and dark palettes |

The backgrounds are Wallpaper Engine wallpapers by their own creators, not part of Prism:
[K-ON RAIN LIVE WALLPAPER](https://steamcommunity.com/sharedfiles/filedetails/?id=2406625656),
[Punklorde (desktop resolution)](https://steamcommunity.com/sharedfiles/filedetails/?id=3422072291) and
[初音-AniLuoty](https://steamcommunity.com/sharedfiles/filedetails/?id=3702521609) on the Steam Workshop.
Prism ships none of them; you point a theme at a file you already have.

## Codex on Windows

The [Codex implementation](platforms/chatgpt-windows/README.md) applies a local image or muted looping MP4/WebM to the regular signed-in Windows app. It samples a matching theme, then lets you adjust the font, panel tint, accent, opacity and corners. These are saved together with the wallpaper and can be restored by name. It does not use Claude's JSON theme files.

Install Node.js 22 or later, then from `platforms/chatgpt-windows` run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
```

Fully quit ChatGPT/Codex, including its tray process, and reopen it. Select Prism from the composer's slash list. For example, with your own copy of the [Miku wallpaper](https://steamcommunity.com/sharedfiles/filedetails/?id=3702521609):

```text
/prism bg "C:\path\to\初音.mp4"
```

Tailor and save a theme with `/prism dim`, `/prism theme tint`, `/prism theme accent`, `/prism theme font`, `/prism theme opacity`, `/prism theme radius`, and `/prism theme save`. The complete [Miku Starlight recipe](platforms/chatgpt-windows/README.md#miku-starlight-example) shows values that work with this video. After saving it, `/prism theme use "Miku Starlight"` restores the combination. Prism keeps the media in a local store; this repository does not include the wallpaper.

The Windows integration registers a current-user helper and a package debug callback. Its [setup and limits](platforms/chatgpt-windows/docs/preview-readme.md) explain the local debugging endpoint, compatibility check and removal path. The separately managed image-only prototype remains documented in the platform README.

## Install for Claude Desktop

At the prompt of a Claude Code terminal session:

```
/plugin install prism-themes --marketplace f1ymango/prism-themes
```

From a shell:

```bash
claude plugin install prism-themes --marketplace f1ymango/prism-themes
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace
with `f1ymango/prism-themes`, then Add plugin.

Then, in a Code session in Claude Desktop:

1. Type `/prism`. A strip opens above the prompt.
2. For full themes, press **Install extension**, then quit Claude Desktop fully (Windows: also from the system
   tray; macOS: Cmd+Q) and open it again.
3. Pick a theme. **Claude** returns to the app's own look.

## How it draws

| | Official backdrop | Extension (optional) |
| --- | --- | --- |
| How | Claude Desktop's own `$.ui.backdrop` mod API | a content script in the app's React DevTools extension slot, loaded when `REACT_PROFILE=1` |
| What | gradient backgrounds, frosted panels | colours, fonts, corners, reactions; picture, slideshow, SVG and video backgrounds |
| Needs | an app version that draws backdrops | one install and a restart |

Prism uses the official API where the app supports it and the extension elsewhere, and says which in the strip.

## Commands

| Command | What it does |
| --- | --- |
| `/prism` | open or close the theme strip |
| `/prism use <id>` | switch theme for this session |
| `/prism bg <file or folder>` | your own background: a picture, an animated SVG, a video, a folder of pictures (a slideshow), or a folder holding one video (a Wallpaper Engine wallpaper) |
| `/prism bg off` | back to the theme's own background |
| `/prism dim 0.3`, `/prism fit contain`, `/prism every 30` | dim, fit, and slideshow interval |
| `/prism panels glass\|clear\|solid` | how the side panels sit over a background |
| `/prism reload` | re-read your themes folder |
| `/prism import <folder>` | import themes made for claude-desktop-themes |
| `/prism doctor` | what Prism found: the app's data folder, both drawing paths, your themes and their problems, the rule in force |

Files are judged by their content, not their name, with size limits of 15 MB per picture, 2 MB per SVG and 50 MB
per video.

## Your own themes

Ask Claude to "make me a theme". The `make-theme` skill asks what you want, drafts a preview, and writes the theme
after you approve it. Or write one yourself: a theme is a JSON file in

- Windows: `%USERPROFILE%\.claude\prism-themes\themes\<id>.json`
- macOS: `~/.claude/prism-themes/themes/<id>.json`

```json
{
  "schema": 2,
  "id": "night-market",
  "name": "Night Market",
  "extends": "dusk",
  "palette": {
    "light": { "bg": "#f6f1e7", "text": "#2a2622", "accent": "#b4471f" },
    "dark": { "bg": "#151a2e", "text": "#efe9df", "accent": "#ff9a4d" }
  },
  "shape": { "radius": 10, "composerRadius": 20 },
  "background": { "file": "lanterns.mp4", "dim": 0.3 },
  "panels": "glass",
  "status": { "idle": "🏮", "tool": "🏮 {tool}…", "error": "🏮 {tool} failed", "done": "🏮 done" }
}
```

The full format, with stylesheets and the attributes they can react to, is in
[skills/make-theme/SKILL.md](skills/make-theme/SKILL.md). [examples/](examples/) has a light/dark theme and a
`rules.json` that picks themes by project folder and time of day (it goes in `.claude\prism-themes\`).

Secondary and muted text always keep a WCAG AA contrast (4.5:1) against the theme's background, whatever the palette.

## Remove

Press **Remove extension** in `/prism`, then restart Claude Desktop. This undoes exactly what the install did: its
files, its manifest entries, and `REACT_PROFILE` only if the install was the one that set it. Another extension in
the same slot is left alone. Then uninstall the plugin (Settings → Plugins, or `claude plugin uninstall
prism-themes`). Your themes folder stays.

## Safety

- The extension runs only on `https://claude.ai/*`, top frame, and applies data the mod wrote.
- Stylesheets may not load anything from outside the page: no `@import`, no `url()` but `data:`, no CSS escapes.
- Background files are copied into the extension folder and shown as page elements, never through CSS.
- Nothing is fetched from the network.

## Known limits

- The Terminal and Browser panes keep their own backgrounds: the terminal paints on a canvas, and the browser pane
  is a separate web page.
- The official backdrop API is not drawn by every app version; until it is, backgrounds need the extension.
- Windows and macOS only.

## Development

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT. Parts of `core/palette.ts` and `core/manifest.ts` are adapted from claude-desktop-themes (MIT); see
[LICENSE](LICENSE).
