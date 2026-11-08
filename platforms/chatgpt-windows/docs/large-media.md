# Large media and portable preview

Implementation version 6 raises native MP4/WebM support from 30 MiB to 128 MiB. Static images retain the 15 MiB limit and decoded video retains the 8,294,400-pixel limit. No new JavaScript dependencies or network media server are introduced.

## Transfer behavior

`src/media-transfer.mjs` sends 512 KiB chunks to a temporary, owner-scoped renderer transfer. It rechecks the source hash and byte count before applying the completed video. Changed files, wrong owners, out-of-order chunks, oversized chunks, incomplete transfers, and cancellation cannot replace the previous wallpaper. Pending transfers expire if the helper disappears.

The renderer creates a Blob only after the complete transfer is accepted and validates decoding/playback before swapping media. The host does not retain a full base64 video in its cache. Status heartbeats continue while uploading; `updatingWindows` identifies active updates without suggesting an app restart. `off`, helper stop, or a changed media selection can cancel an in-flight upload. Dimming/fit changes and selecting the same saved media reuse the current decoder.

This avoids a single huge debugging expression; it does not make memory use independent of file size. The controller/validator still reads each bounded file, and the renderer retains compressed media in a Blob. Larger real-world codecs and gaming workloads still require performance acceptance.

The installed acceptance check also exposed historical activation records whose PIDs had been reused by unrelated processes. Discovery now ignores records that fail executable/creation-time identity matching instead of presenting them as current attachment failures. Identity checks remain mandatory. A focused isolated regression with a live unrelated PID passed; evidence is in `docs/evidence/stale-activation.json`.

## Verification

The 38 unit tests passed, including bounded-message reproduction, source-change rejection, transfer cancellation, owner/order/size/expiry checks, and progress status. The owned visible-app integration test passed MP4/WebM playback, loop wrap, repeated-selection decoder preservation, settings, pause policy, invalid-video recovery, source/Blob cleanup, and preservation of original user app processes.

Measured command-to-applied times on this machine:

| Input | Dimensions | Elapsed |
| --- | --- | --- |
| Real 41,005,617-byte MP4, previously rejected by the old cap | 1920x1080 | About 4.8 seconds |
| 41,949,889-byte procedural fixture | 320x180 | About 5.2 seconds |
| Exactly 134,217,728-byte fixture | 320x180 | About 11.6 seconds |

The larger procedural fixtures contain valid MP4 `free` padding; they establish transfer/size-boundary behavior, not high-bitrate or 4K decoder performance. Cancelling an active maximum-size transfer with `off` cleaned up in about 0.1 seconds. These timings are observations, not guarantees. Evidence: `docs/evidence/large-media.json`.

## Source preview

`scripts/package-preview.ps1` produces a local source archive with a file/hash manifest and portable installation instructions. It copies allowed source/test/demo files and excludes local profiles, wallpapers, screenshots, logs, raw machine-specific evidence, and app/runtime binaries. The package is marked as an engineering preview with publication and licensing decisions pending.

The extracted archive passed all 38 tests, an isolated no-hook setup under a path containing spaces and non-ASCII characters, idempotent setup, and removal. The real user's package callback and login registration were unchanged. PowerShell JSON/skill readers now explicitly use UTF-8. This fixture does not replace testing on a different Windows machine/account or an actual Windows login. Evidence: `docs/evidence/source-preview.json`.

The final local artifact is recorded in `docs/evidence/source-preview-artifact.json`. The installed version-6 upgrade preserved user preferences and original app processes. Final status showed one applied visible video view, one deferred hidden view, no errors, and no restart requirement. A live renderer check confirmed muted playback and the existing translucent surfaces; evidence is in `docs/evidence/version6-live.json`.
