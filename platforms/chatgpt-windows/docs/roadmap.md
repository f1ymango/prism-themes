# Current roadmap status

Updated 8 November 2026 (Hong Kong).

The project has user-confirmed static and video wallpapers in the normal signed-in Codex view. Version 5 added translucent composer/cards/Outputs surfaces and removed opaque scroll-fade backdrops. Version 6 supports native videos up to 128 MiB through bounded transfers, progress status and cancellation, and UTF-8 installation paths. A real previously rejected 39.1 MiB video, 40 MiB/128 MiB fixtures, loop wrap, and cancellation passed. A local source preview passed extracted-source tests and isolated installation/removal from a path containing spaces and non-ASCII characters. Actual future-update, independent clean-machine, Windows login, and gaming performance testing remain outstanding.

| Stage | Status | Evidence or remaining work |
| --- | --- | --- |
| Renderer loading and restoration | Complete on the pinned build | Isolated runtime loading, ownership checks, restoration, watchdog expiry, and unchanged installed-file hashes passed. |
| Static wallpaper engine | Complete for the MVP | PNG/JPEG/static WebP, image validation, switching, dimming, fit, position, saved local files, and invalid-image recovery are implemented. |
| Ordinary startup and composer control | First user acceptance passed | The real Prism skill invokes setup/status/wallpaper commands. One-time setup deploys a background helper and login registration. Native Windows activation and live changes passed lifecycle tests; the user's signed-in screenshot confirms rendering in their installed session. |
| Reliability and compatibility | Recovery and build-check milestones delivered | `/prism repair` checks unfamiliar builds in an isolated profile, caches exact approved fingerprints, and uses version-specific executable links. Current-build compatibility proof passed; no future release is available to validate an actual update. See [compatibility](update-compatibility.md) and [reliability](reliability.md). |
| Live/video wallpaper | First user acceptance passed | Local muted looping MP4/WebM, live switching, settings without decoder restart, hidden/reduced-motion pause policy, invalid-video recovery, and decoder/Blob cleanup passed. The user's MP4 is now confirmed in the normal session. Representative CPU/GPU, gaming, and hours-long playback checks remain. See [video](video-wallpaper.md). |
| Surface transparency | Current Codex dark view verified | Composer, resource cards, and Outputs/Sources use translucent tints; top/bottom scroll-fade backdrops are removed. Focused rendering/restoration checks and live verification passed. Other themes and views remain unverified. See [surfaces](surface-transparency.md). |
| Large media and command consistency | Verified | Native MP4/WebM support up to 128 MiB with bounded messages, progress heartbeats, cancellation, source-change detection, and repeated selection without decoder reset. See [large media](large-media.md). |
| Distribution and finishing work | Local source preview verified | Install/remove entry points, original demo images, source hash manifest, private-artifact exclusion, 38 extracted-source tests, and isolated Unicode-path setup/removal passed. Publication and licensing decisions, independent clean-machine acceptance, and operational performance checks remain. |

## Recommended next milestone

Prioritize real minimize/restore, representative playback/gaming performance, and longer-session experience. Complete independent clean-machine acceptance before a public beta. Additional animated image formats can follow actual demand; the first preview remains focused on static images and local MP4/WebM.

## Evidence

- `docs/evidence/native-setup.json`: automated lifecycle results and user-assisted acceptance.
- `docs/native-setup.md`: implementation, operating properties, and remaining limits.
- `docs/native-command-feasibility.md`: the investigation that established the normal-activation route.
- `docs/evidence/reliability.json`: recovery, visible-window, and installed-upgrade results.
