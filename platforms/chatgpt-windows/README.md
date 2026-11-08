# Prism for the ChatGPT desktop app

A Windows image and video wallpaper integration controlled through the ChatGPT composer's Prism skill. The first install registers that skill and a user-scoped background helper; after one full app restart, ordinary Windows activation prepares the app for live wallpaper commands.

Verified on Windows package OpenAI.Codex 26.1103.4239.0, embedded app 26.1103.32239. After app updates, `/prism repair` tests an unfamiliar build in an isolated profile before approving its fingerprint. MP4/WebM playback and cleanup passed in an owned visible app window. Actual Windows login, hours-long sessions, detached windows, Chat/Work views, a future app release, and gaming performance remain unverified. See the [current roadmap](docs/roadmap.md), [update compatibility](docs/update-compatibility.md), and [video milestone](docs/video-wallpaper.md).

## First install and native composer commands

Install Node.js 22 or later, open PowerShell in this folder, and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
```

The installer registers the Prism skill. Once it reports ready, fully quit ChatGPT, including its tray process, and reopen it from its usual icon. Then select Prism from the composer's slash list. Subsequent wallpaper changes apply live in prepared windows. These commands run through an agent turn.

| Command | Action |
| --- | --- |
| `/prism setup` | Re-enable an installed integration; repeated setup reuses a healthy worker |
| `/prism bg C:\Wallpapers\image.png` | Validate, save locally, and apply an image |
| `/prism bg C:\Wallpapers\video.mp4` | Apply a muted looping MP4 or WebM video |
| `/prism repair` | Refresh Prism and check the installed app build after an update |
| `/prism dim 40%` | Set dimming |
| `/prism fit contain` | Fit the whole image |
| `/prism position top` | Align at the top |
| `/prism off` / `/prism on` | Restore appearance or re-enable the saved image |
| `/prism status` | Report helper state, prepared windows, and restart requirements |
| `/prism remove` | Disable the callback and login startup; restore attached windows |

Removal retains local wallpaper files and the skill for reinstall. Fully restart the app to close an already-open debugging endpoint. Setup and removal do not automatically close app windows. See [native setup](docs/native-setup.md) for implementation, verification, and limits.

Images are limited to 15 MiB and 40 million pixels. Native video commands support up to 128 MiB and 8,294,400 pixels (3840×2160), transferred in bounded chunks. `updatingWindows` reports active transfers, and `off` can cancel them. Video pauses for hidden documents and reduced-motion preferences; a new video selected while hidden loads when the window becomes visible. Codec support depends on the installed app. The older separate-window prototype below retains its image-only picker. See [large-media results](docs/large-media.md).

Prism also themes the composer, resource cards, and Outputs/Sources panel with translucent surfaces and removes the default top/bottom scroll-fade backdrops. These styles restore with `off` or removal. See [surface transparency](docs/surface-transparency.md) for scope and verification.

`Install.ps1` and `Uninstall.ps1` provide setup/removal entry points. A local source preview can be built with `scripts/package-preview.ps1`; it excludes user state, media, screenshots, logs, and runtime/app binaries and includes a source hash manifest. See the [portable preview instructions](docs/preview-readme.md). This source is covered by the repository's MIT license; a standalone release has not been published.

## Earlier separate-window prototype

These shortcuts are in this project folder:

| Shortcut | Action |
| --- | --- |
| **Launch Prism.lnk** | Open the Prism window with your saved wallpaper |
| **Choose Wallpaper.lnk** | Select a PNG, JPEG, or WebP image; update the window or launch it |
| **Stop Prism.lnk** | Close only the Prism-managed window and its debugging listener |

## Change the wallpaper inside the open app

Click the **Wallpaper** button at the lower right, or press **Ctrl+Alt+P**. The panel includes **Choose image…**, dimming, fit, and position controls. Pick an image directly from this panel; the selected image and settings are saved locally in the Prism profile.

The panel's command field accepts these commands immediately, without sending a chat message:

| Command | Action |
| --- | --- |
| `choose` | Open the in-app image picker |
| `dim 40` | Set dimming to 40% |
| `fit contain` | Fit the entire image |
| `fit cover` | Fill the window |
| `position top` | Align the image at the top |
| `hide` | Collapse the panel |
| `reset` | Restore the default appearance |

An optional `/prism` prefix is accepted **in this panel's command field**. These commands are not registered in ChatGPT's main composer. Ctrl+Alt+P reopens the collapsed panel and focuses its command field.

**Restore appearance** removes the wallpaper and its controls while leaving that window open; use Launch Prism again to re-enable it. **Close Prism window** exits the managed window.

Existing Prism-enabled windows can receive the new controls without relaunching:

```powershell
node scripts/update-open-prism.mjs
```

The updater selects the uniquely Prism-owned app window, preserves its current image/settings, and disconnects without closing the window. It refuses ambiguous ownership.

The earlier loader only reaches its separately managed window. The native setup above uses a package callback on future ordinary activations; it cannot add debugging retroactively to a process that was already running before setup.

The [native feasibility investigation](docs/native-command-feasibility.md) records how composer invocation, local execution, and package activation were established. The skill now routes setup, wallpaper, and removal commands to the implementation above.

Your normal app window can remain open. Prism uses a separate persistent UI profile and the normal backend account storage. It does not copy credentials or patch installed files. The tested account reached its signed-in composer automatically. A signed-out account can use the app's regular sign-in flow manually.

The included landscape is an original procedural test image. Replace it with your own using Choose Wallpaper. Files are identified from their bytes, limited to 15 MiB and 40 million pixels, and decoded before replacing the current image. Animated formats are outside this version's scope.

## Terminal commands

Node.js 22+ is required; testing used the existing Node.js 24.22.1 runtime. No npm installation, third-party JavaScript dependencies, or API key is needed. Run these from the project directory:

```powershell
node scripts/start-prism.mjs
node scripts/start-prism.mjs --choose-image
node scripts/start-prism.mjs --image "C:\Wallpapers\my-picture.png" --dim 0.4 --fit cover
node scripts/start-prism.mjs --status
node scripts/start-prism.mjs --stop
```

If the Node.js path or project location changes, regenerate the shortcuts:

```powershell
node scripts/create-shortcuts.mjs
```

The launcher discovers the installed package. Supply --app-dir with the directory containing ChatGPT.exe if discovery is unavailable. Unknown builds and changed installed-file hashes are rejected until reviewed.

## Saved state and stopping

- .prism-user/settings.json: chosen image path and appearance settings.
- .prism-user/profile/: separate persistent Prism UI profile.
- .prism-user/status.json: current manager state and configuration warnings.
- .prism-user/last-error.json: startup error, when one occurred.
- .prism-probe/: local logs, reports, test profiles, and screenshots.

These directories and machine-specific shortcuts are excluded from version control. Signed-in screenshots remain in the ignored local artifact directory.

One manager owns the Prism profile. Launching again updates its settings instead of opening a duplicate manager. Stop Prism uses an owned local stop request, not an arbitrary process kill. The renderer restores appearance if the manager stops renewing its watchdog.

The older launcher keeps a loopback-only Chrome DevTools Protocol listener open for its managed instance's lifetime. Stop Prism closes that window and listener. That older path does not register startup. The native setup above explicitly registers a user helper and Windows package callback; neither path changes firewall settings or installed package files.

## Validation and limits

The declared automated suite passes 38 tests:

```powershell
node --test (Get-ChildItem -LiteralPath test -Filter '*.test.mjs').FullName
```

Live checks covered registered Windows activation and package identity; the signed-in composer; wallpaper behind the main surface and sidebar; saved control changes; reuse of the persistent UI profile; and explicit stop with listener cleanup. Installed-file hashes stayed unchanged and the original app process remained alive.

The isolated wallpaper proof also verified PNG/JPEG/WebP decoding, image switching, resource release, invalid-image recovery, controls, an emulated viewport change, restoration, and timer expiry.

The in-app control proof also passed file selection through Prism's own HTML input, invalid-file recovery, commands, keyboard toggling, local image/settings restoration after reinjection, and keyboard-handler removal. The file input was populated through CDP; the OS file-dialog interaction itself was not automated.

An already-open signed-in Prism window was updated without restarting it; its image, settings, process, and installed-file hashes were preserved. The native integration has also passed an owned visible-window MP4/WebM playback and cleanup check. Actual Windows login, long sessions, detached windows, Chat/Work views, and future app releases remain unverified.

See [in-app controls](docs/in-app-controls.md), [the launcher milestone](docs/milestone-2.md), and the [original loading experiment](docs/phase-1-findings.md). The original Claude Prism project is [f1ymango/prism-themes](https://github.com/f1ymango/prism-themes).
