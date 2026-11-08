# Phase 1: reversible ChatGPT desktop loading

Date: 7 November 2026 (Hong Kong)

## Result

A temporary Chrome DevTools Protocol connection can execute an isolated script that adds and removes a DOM/style marker in the signed-out interface of the installed Windows production executable. Two consecutive complete runs passed all live assertions, with screenshots captured before and after marker removal.

This is a successful isolated loading experiment. Applying the loader to an authenticated, normally activated user session remains unverified.

## Verified target

| Item | Observed value |
| --- | --- |
| Windows package | `OpenAI.Codex`, version `26.1103.4239.0` |
| Executable | Installed `ChatGPT.exe` |
| Embedded app | `openai-codex-electron`, version `26.1103.32239`, build flavor `prod` |
| Runtime | Chromium `157.0.8103.39` |
| Renderer | `app://-/index.html` |
| Interface tested | Signed-out screen with four visible controls |
| Test harness runtime | Node.js `24.22.1` |

The full executable and archive fingerprints are stored in `src/compatibility.mjs` and captured evidence. The probe refuses an unknown baseline.

## Loading mechanism

The installed app's React DevTools extension loader is gated by an unpackaged-app check. The production build also restricts its normal DevTools setting. Nevertheless, a separately launched instance accepts an ephemeral loopback remote-debugging listener and exposes the app renderer through CDP.

The harness launches that same installed binary with separate application and backend state directories. It verifies the listener's process ownership before connecting, attaches only to the app's own top-level renderer, creates an isolated JavaScript world, and adds the marker directly to the shared DOM. No extension installation, archive patch, new executable, account sign-in, or modification of the existing profile is needed for this experiment.

The marker consists of one owned element with a shadow root. It has no input handlers, ignores pointer events, and is hidden from assistive technologies. It removes itself through a timer even if the debugging connection disappears, provided the renderer continues executing timers.

## Validation

Both complete runs verified:

- Interface readiness beyond the startup splash.
- Marker application, visible dimensions, and one instance after repeated application.
- Rejection of removal by a different probe owner.
- Explicit removal and automatic timer expiry.
- Visible interface controls remaining after removal.
- A loopback-only listener belonging to the spawned process.
- Test-process shutdown and absence of the debug listener afterward.
- Matching full executable and ASAR SHA-256 hashes before and after.
- The pre-existing app root process remaining alive with the same creation time.

The automated suite passed 11 tests covering malformed archives, compatibility mismatches, transport failures, and marker boundaries. Screenshots were visually inspected: the marker appeared at the upper right of the actual sign-in screen and was absent after removal.

## Issues found during implementation

1. The restricted execution sandbox prevented the application's crash handler from starting. Running the authorized test outside that sandbox resolved the startup failure.
2. An early successful marker test captured only the startup splash. Readiness now requires a complete document and visible interface controls.
3. A TCP-connect timeout gave an inconclusive cleanup result after the process had already exited. Cleanup now checks the Windows listener table directly.
4. A fixed 600 ms wait was insufficient for the short expiry test in a background renderer. The harness now polls for actual timer-driven removal for up to five seconds.

The failed diagnostic runs remain in `.prism-probe/` for audit. The published evidence points to the two later complete passing runs.

## Remaining limitations

- The isolated profile is signed out. Conversation rendering, sending, tools, file previews, and Chat/Work/Codex navigation have not been tested.
- Launching the executable directly does not reproduce Windows packaged activation. The test process logged missing package identity; updater and other identity-dependent integrations are unverified.
- The current running user session has no debugging listener and was not changed. Reusing this route for that session would require a separately planned launch arrangement.
- The debugging connection exists for the duration of the short experiment. A persistent loader must establish its own lifecycle and access boundaries; this harness is not that installer.
- Wallpapers, local media delivery, panel transparency, and video performance are outside this phase.
- Only the recorded Windows build has been tested. No macOS or cross-version support is claimed.

## Next implementation target

Use the proven isolated renderer connection to test one static local image and map the main interface surfaces. Resolve normally activated, authenticated-session loading before offering a daily-use installation.

## Evidence

- [Passing-run summary](evidence/summary.json)
- [Marker visible](evidence/marker-visible.png)
- [Marker removed](evidence/marker-removed.png)
