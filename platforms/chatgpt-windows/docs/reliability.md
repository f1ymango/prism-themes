# Reliability milestone

Date: 8 November 2026 (Hong Kong).

Implementation version 2 is installed in the user's existing Prism installation. The upgrade preserved preferences and all pre-existing app root processes. The installed helper reattached to two app views, with no reported errors or restart requirement.

## Changes

- A small `PrismHelper.exe` is the login entry and supervisor. The installed registry command is 58 characters. The former PowerShell command exceeded the documented 260-character limit for Windows Run entries. The supervisor uses a single-instance mutex, restarts a failed worker with a bounded budget, and can adopt an already healthy worker when relaunched.
- The worker restarts a failed renderer host and resets its rapid-failure budget after a healthy interval. An unverified package or hash pauses recovery rather than repeatedly launching workers.
- Window attachment runs independently. A page waiting to finish startup cannot prevent other pages from renewing their wallpaper leases. Reloaded renderers reattach, and the browser discovery connection can reconnect after a transport failure.
- Status includes supervisor state and recovery state. A stale renderer heartbeat cannot claim a live wallpaper. A view still attaching reports recovery rather than an immediate app-restart requirement.
- Atomic state writes retry brief Windows file-sharing failures. Direct .NET SHA-256 checks replace dependence on PowerShell's `Get-FileHash` function. Setup waits for a newly started worker instead of treating an older worker's error as the new result.
- `repair` refreshes the implementation with `-Upgrade`. Healthy setup remains idempotent. Shutdown and removal wait for both worker and supervisor, preserving ChatGPT processes.

## Verification

All 30 automated tests passed, including a real Windows reader that temporarily denies file replacement and regressions for stale status, loading views, and compatibility pauses.

The recovery fixture used owned isolated app processes and seeded discovery records after verifying package identity, PID creation identity, and loopback listener ownership. It did not replace the user's active package callback or login registration. Consequently, these are recovery tests rather than a new proof of the native package callback; that callback was established by the earlier activation tests and remains enabled in the real installation.

The complete live gate passed:

- Image synchronization across app-owned windows.
- Renderer-host termination and automatic replacement.
- A deliberately unfinished view held for 26 seconds, longer than the 20-second wallpaper lease, while another view retained its wallpaper.
- Renderer reload recovery.
- Worker termination and automatic replacement by the supervisor.
- Relaunch of the short startup entry, adopting the live worker, and duplicate-entry suppression.
- Saved image after a cold isolated app session.
- A deliberately mismatched expected hash pausing recovery without a restart loop.
- Repair reattaching to an already-open app after the expected hash was restored.
- Removal restoring the remaining views, listener cleanup, and preservation of original user app processes and registrations.

A focused follow-up opened two visible native Windows windows through the app's own new-window bridge, verified image synchronization, and cleaned up both. Owl rejects `Target.createTarget`, so the fixture uses the app-owned path rather than treating Chromium tab creation as an available feature.

Local full reports:

- `.prism-probe/r6908c8cc/reliability-report.json`: complete recovery gate.
- `.prism-probe/rfb901f45/reliability-report.json`: two visible native windows.
- The latest `.prism-probe/installed-backup-*/upgrade-report.json`: installed upgrade and settings/process preservation.

The portable summary is `docs/evidence/reliability.json`.

## Remaining acceptance

An actual Windows sign-out/sign-in or reboot has not been performed. The short login command was exercised directly, but that does not reproduce Windows login scheduling. Microsoft notes that Run entries may be delayed and have no guaranteed execution order. If ChatGPT starts before the callback is armed, that already-running process still needs a full app restart.

Hours-long sessions, Chat/Work views, detached windows, and future app releases remain unverified. Detached windows are not currently targeted. A healthy worker can continue if the supervisor exits, but relaunching setup is required to restore monitoring in that case; the supervisor does not monitor its own process. Support remains pinned to the verified app build.

Reference: [Microsoft Run and RunOnce registry keys](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys).
