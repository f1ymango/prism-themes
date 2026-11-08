# Prism desktop wallpaper - source preview

Unofficial local wallpaper customization for the Windows ChatGPT/Codex desktop app. The currently verified view is Codex in Windows package `OpenAI.Codex`. This is a local engineering preview; publication and licensing decisions are pending.

## Requirements

- Windows x64 with the official desktop app installed.
- Node.js 22 or later on PATH during installation. The installer copies a standalone runtime for subsequent use.
- The Windows .NET Framework compiler available at `Microsoft.NET\Framework64\v4.0.30319\csc.exe`.

No npm dependency installation or API key is required. This source archive contains no OpenAI app binaries, Node binaries, user wallpapers, sign-in data, screenshots, or local logs.

## Install once

Extract the archive, open PowerShell in its folder, and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
```

Fully quit the desktop app, including its tray process, and reopen it from its usual icon. Prism does not close the app for you. After installation, daily use does not require this extracted source folder.

Select Prism in the composer's slash menu and send commands such as:

```text
/prism status
/prism bg "C:\Wallpapers\image.png"
/prism bg "C:\Wallpapers\video.mp4"
/prism dim 40%
/prism fit contain
/prism off
/prism on
```

Commands execute through an agent turn. PNG/JPEG/static WebP support up to 15 MiB and 40 million pixels. MP4/WebM support up to 128 MiB and 8,294,400 decoded pixels. Codec availability depends on the app; H.264 MP4 and VP8/VP9 WebM are intended inputs. Videos are muted and looping. Hidden and reduced-motion views pause playback; a new video in a hidden view loads when that view becomes visible. Larger files may take several seconds to transfer.

The composer, resource cards, and Outputs/Sources panel are translucent. Reviewed top/bottom scroll fades are removed. Native styling returns with `off` or removal.

## Repair and removal

After an app update, use `/prism repair`, or rerun `Install.ps1 -Repair`. An unfamiliar fingerprint must pass an isolated compatibility check. A failure leaves the existing configuration intact. Structural app changes may still require a Prism update.

Use `/prism remove` or run `Uninstall.ps1` to stop Prism and remove its owned callback and login startup registration. Wallpaper files are retained. Fully quit and reopen the app afterward to close a debugging endpoint already enabled in that process.

## Implementation and limits

Prism registers a current-user Windows package-debug callback and login helper, prepares fresh app activations for a loopback debugging connection, and applies its own renderer styles/media. Installed app files are not patched. Package-debug mode affects app lifecycle behavior; local processes can potentially access an enabled debugging endpoint. This mechanism is unofficial, and terms-of-service compliance remains unresolved. A working installation does not imply vendor permission.

Automated checks cover transfer bounds, cancellation, looping, settings, recovery from invalid video, resource cleanup, and style restoration on the verified build. Tests also exercise an isolated installation extracted into a path containing spaces and non-ASCII characters. This is not a substitute for independent clean-machine, Windows login, future-app-update, gaming performance, or hours-long playback acceptance. Other app views and light mode remain unverified. GIF, animated WebP/APNG, and online wallpapers are not included in this preview.

## Tests and source packaging

```powershell
node --test (Get-ChildItem -LiteralPath test -Filter '*.test.mjs').FullName
node scripts/native/test-video.mjs
node scripts/native/test-surfaces.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/package-preview.ps1
```

The package manifest lists the archive's source files and hashes. Generated local state and evidence are excluded from the archive. Keep supplied media and credentials out of any source publication.
