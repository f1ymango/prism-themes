# Native setup milestone

The Prism skill has working setup, status, image, dimming, fit, position, on/off, and removal routes. The implementation uses the Windows package activation mechanism established by the earlier probe. The first real user setup completed successfully. A subsequent status command reported two prepared/applied windows with no errors or restart requirement, and the user supplied a screenshot showing wallpaper in the signed-in Codex conversation view.

## User workflow

1. Select Prism in the slash menu and send `setup`.
2. When the worker reports ready, fully quit ChatGPT, including any tray process, then reopen it through its usual icon.
3. Use `bg <absolute local file>` to choose an image, or use the image already saved by setup. Use `status` to verify that `appliedWindows` is positive.

Setup copies a standalone Node runtime and the helper into `%LOCALAPPDATA%\PrismChatGPT`. It registers one current-user login entry, `PrismChatGPTWallpaper`, pointing to the short `PrismHelper.exe` command. That hidden supervisor starts and monitors the worker. Existing Prism image preferences are used when available; otherwise setup starts with the supplied test image. New image choices are byte-validated and copied into local content-addressed files, so ordinary use does not depend on the original image path or development checkout remaining available.

`off` restores appearance while leaving the integration ready. `remove` stops the helper, disables only its owned package callback and login entry, and restores attached windows. Wallpaper files and the skill remain available for reinstall. A full app restart is needed to close a debugging endpoint already enabled in that app process.

## Components

- `native/ActivationCallback.cs`: validates package, user, process image, and initial thread; adds the debugging flag only to a fresh activation. A stale helper heartbeat causes native activation to resume without the edit. Existing custom-profile launches and existing debugging configurations are preserved.
- `native/PackageSession.cs`: owns the Windows debugging interface for the worker's lifetime.
- `native/PrismHelper.cs`: short login entry, single supervisor instance, worker recovery budget, and adoption of a healthy worker.
- `scripts/native/install.ps1`: build approval checks, owned deployment, callback compilation, skill registration, login startup, and worker readiness. Repeated setup reuses an already healthy worker.
- `scripts/native/worker.ps1`: single-instance mutex, callback lifetime, hidden renderer host, heartbeat, and app-update detection.
- `scripts/native/host.mjs`: discovers only callback-recorded processes, verifies PID creation identity and loopback listener ownership, and independently attaches to supported app pages. It renews healthy wallpapers while other views load, and reattaches after reloads. It never starts or closes the user's app.
- `scripts/native/control.mjs`: validates commands and images, saves preferences atomically, and distinguishes saved settings from a confirmed live application.
- `scripts/native/remove.ps1`: stops only this helper and disables only owned registrations; it keeps app processes open.

The renderer lease expires after 20 seconds if the helper stops renewing it. Graceful removal also sends an explicit restore request. An unknown package version or changed executable/archive hash prevents the callback from being armed. `/prism repair` runs the [isolated compatibility check](update-compatibility.md) before approving a new fingerprint; failed checks preserve the existing integration state. The same `bg` command accepts [local MP4/WebM video](video-wallpaper.md).

## Verification

The real Windows lifecycle fixture installs into an owned workspace directory, temporarily registers the callback, and activates the official app using Windows.Launch with an isolated profile. It checks automatic wallpaper application, live image commands, dimming, on/off, invalid-image recovery, idempotent setup, removal while keeping the app open, and saved-image recovery after reinstall. The fixture leaves the real user skill and login startup untouched and removes its callback afterward.

Run the fixture with:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/native/test-lifecycle.ps1
```

The summary is in `docs/evidence/native-setup.json`; full local artifacts are under `.prism-probe/`.

The signed-in normal-profile rendering check has user-assisted acceptance. The [reliability milestone](reliability.md) also verifies two visible native windows, renderer and worker recovery, repeated isolated sessions, and live repair. Still unverified: an actual Windows sign-out/sign-in, Chat/Work views, hours-long sessions, detached windows, and compatibility after a future app update. Detached windows are not currently targeted by the host.

## Operating properties

Windows package-debug mode changes package lifecycle behavior while enabled. A loopback CDP endpoint gives other local processes access to the prepared renderer. These properties are why setup is explicit, registrations have ownership checks, app builds are pinned, and removal reports the remaining restart requirement. There are no network wallpaper downloads, credential copying, or installed package patches.
