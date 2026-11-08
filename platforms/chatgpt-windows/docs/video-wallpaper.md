# Local video wallpaper milestone

Use `/prism bg C:\Wallpapers\video.mp4` or a WebM path in the existing composer. The command validates the bounded local container, saves a content-addressed copy, and updates prepared windows through the existing helper. The original file can subsequently be moved. Static images continue to use the same command and preferences schema.

Video is muted, looping, inline, and inaccessible to pointer input. MP4 and WebM containers are identified from bytes; actual decoding and autoplay must succeed before a working background is replaced. Supported codecs depend on the app runtime; H.264 MP4 and VP8/VP9 WebM are the intended inputs. Native version 6 supports 128 MiB through chunked transfers and 8,294,400 decoded pixels. Static-image limits remain 15 MiB and 40 million pixels. No new dependencies are required.

Video pauses on document visibility changes and reduced-motion preferences. The app's hidden internal window suspends video loading, so the host defers a new video there until it becomes visible while retaining the previous background. Dimming, fit, and positioning reuse the same video element. Native-mode media is stored as a local file rather than duplicated into renderer IndexedDB. Replacement, `off`, removal, and lease expiry release the video source and Blob URL. A rejected replacement keeps the previous wallpaper alive.

`scripts/native/test-video.mjs` creates procedural VP8 WebM and MP4 clips using the app's MediaRecorder, opens an owned visible test window, and exercises the actual native controller and host. Playback advancement, settings without decoder replacement, reduced-motion pause/resume, simulated document-visibility pause/resume, undecodable replacement recovery, video-to-image cleanup, `off`, and listener cleanup passed. Existing user app processes were preserved. The evidence is in `docs/evidence/video-wallpaper.json`.

User acceptance passed after the version-4 startup alias correction: the selected MP4 played in the normal signed-in session and the user supplied screenshots confirming it. A version-5 live check also confirmed muted playback with the same video fingerprint after the surface-style upgrade.

Large-file acceptance now includes a real 39.1 MiB 1920x1080 MP4 and padded 40 MiB/128 MiB fixtures. Loop wrap, repeated selection without decoder replacement, progress status, and transfer cancellation passed. See [large-media details](large-media.md).

Remaining acceptance: additional real codecs/bitrates, actual minimize/restore behavior, CPU/GPU usage while gaming, and hours-long playback. The visibility policy test changes the document visibility getter inside the owned isolated world; it is not a Windows minimize test. GIF, animated WebP/APNG, audio playback, and online wallpapers are not implemented in this milestone.
