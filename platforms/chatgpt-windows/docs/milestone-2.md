# Milestone: a signed-in static-wallpaper launcher

Date: 7 November 2026 (Hong Kong)

## Delivered behavior

Prism opens a separate native ChatGPT desktop window through the registered Windows execution alias. This preserves Windows package identity. The window uses the normal backend account storage and a separate persistent UI profile. The tested account reached its signed-in Codex composer without credential copying or restarting the original app.

The wallpaper now covers the main content and sidebar while retaining the composer's native background. Dimming, fit, and position controls save automatically. Project-local shortcuts launch Prism, choose an image through a native file dialog, and stop the managed window.

## Components

| Component | Role |
| --- | --- |
| scripts/start-prism.mjs | Managed session, preferences, configuration changes, stop requests |
| scripts/create-shortcuts.mjs | Project-local Windows shortcuts |
| src/windows.mjs | Registered launch alias and process package identity |
| src/preferences.mjs | Validated settings, atomic saves, manager ownership |
| src/wallpaper.mjs | Local renderer, main-surface adapter, controls, watchdog renewal |
| src/renderer.mjs | Recovery across startup renderer replacements |
| src/session.mjs | Persistent UI profile and owned-process cleanup |

The main-surface adapter selects the reviewed semantic main element with a MainContentSurface- class prefix. It clears only that panel's background color and the reviewed sign-in background where applicable. Message content, native input handlers, and composer backgrounds are preserved.

## Verification

The isolated static-wallpaper proof passed two complete live runs. It covered PNG/JPEG/WebP decoding, switching, controls, invalid-image recovery, an emulated viewport change, explicit restoration, and timer expiry.

Registered launch preserved Windows package identity. The signed-in companion reached a visible editor. Its startup can replace a renderer or briefly time out; connection setup now retries those transitions within a bounded deadline.

Managed-session checks reused the persistent UI profile and saved a dimming control change to 42%. A stop request closed the managed window and listener, preserved the original app process, and left the executable and ASAR SHA-256 fingerprints unchanged. All 22 automated tests pass, including lock ownership and preservation of existing preferences when serialization fails.

Private local reports include:

- .prism-probe/registered-launch-2026-11-07T15-04-58-535Z-62d1cff1/report.json
- .prism-probe/signed-in-2026-11-07T15-14-41-531Z-d418438f/report.json
- .prism-probe/prism-session-2026-11-07T15-21-00-776Z-ea7aafdc/report.json
- .prism-probe/prism-session-2026-11-07T15-23-22-184Z-647a5666/report.json

Signed-in screenshots are kept only in the ignored local artifact directory.

## Remaining scope

Signed-in verification covers the Codex home/composer view. Chat, Work, existing conversations, message sending, and tools need separate checks. Video wallpapers are not implemented. The native file chooser requires a manual user selection. Long sessions and updates need broader validation; only the recorded app build is accepted.

The managed instance keeps a loopback debugging listener while it runs. Stop Prism closes that instance and listener. Normal application launches are unaffected.

The actual Launch Prism and Stop Prism shortcuts were also exercised. Launch reached its running state; Stop produced a passed stop-request report with the listener closed, installed files unchanged, and the original process preserved. No manager lock remained afterward.
