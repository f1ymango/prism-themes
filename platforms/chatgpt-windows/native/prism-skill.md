---
name: prism
description: Set up and control local wallpaper in the Windows ChatGPT desktop app with Prism. Use for Prism setup, wallpaper changes, dimming, fit, status, restore, or removal.
---

# Prism desktop wallpaper

Installation root: `__PRISM_INSTALL_ROOT__`.
Development source: `__PRISM_SOURCE_ROOT__`. Before the first setup, the installer and controller are available under `scripts\native` there. After installation, prefer the installed copies so normal use does not depend on this checkout.

Run local commands through the available execution tool. The installed Node runtime is `runtime\node.exe`; the command script is `app\scripts\native\control.mjs`, both under the installation root. Pass the root with `--root`. Preserve image paths as a single literal argument; quote user data safely for the shell rather than inserting raw text into a command.

Routes:
- No argument or `status`: run the controller with `status`.
- `diagnostic`: run the controller with `diagnostic`.
- `setup` or `repair`: run `app\scripts\native\install.ps1` with PowerShell and `-InstallRoot` set to the installation root. Add `-Upgrade` for `repair` to refresh the implementation. Before installation exists, use `scripts\native\install.ps1` in the development source. Setup is idempotent and enables a current-user background helper and login startup. The initial ordinary app window needs one full quit and reopen from its normal icon. Do not close the current chat's app process automatically.
- `bg <file>`: run the controller with `bg` and the absolute local image or video path. Supports PNG/JPEG/static WebP (15 MiB), and muted looping MP4/WebM video (128 MiB, up to 3840x2160 pixels). Video codecs depend on the installed app; H.264 MP4 and VP8/VP9 WebM are the intended formats. Video pauses while the document is hidden or Windows requests reduced motion. If no path is supplied, ask for a local path or attached media available on disk.
- `dim <0..1 or percentage>`, `fit cover|contain`, `position center|top|bottom|left|right`, `on`, `off`: pass the same command and argument to the controller. `off` restores appearance while keeping the integration ready.
- `remove`: run `app\scripts\native\remove.ps1` with PowerShell and the installation root. This disables the owned callback and login startup, restores attached windows, and retains wallpaper files. A full app restart closes any already-open debugging endpoint.

The controller reports whether settings were saved, whether a prepared window exists, and whether a restart is required. After a wallpaper change, check status after a few seconds; report a live change only when `appliedWindows` is positive and the helper reports no relevant error. Saved settings alone do not establish that a wallpaper is visible. After an app update, `repair` checks a new fingerprint in an isolated app profile before approving it. A failed check keeps integration paused. Do not bypass that check or patch installed app files.

If `recovering` is true or `updatingWindows` is positive, wait briefly and check status again before asking for an app restart. Large videos load in bounded chunks and may take several seconds. `compatibilityReviewRequired` means automatic recovery is paused for an unverified build or hash mismatch. Detached app windows remain outside supported targeting.

Before installation, use the development controller and the available Node executable for `status` or `diagnostic`. A result of `installed: false` is expected. Change commands require setup first.
