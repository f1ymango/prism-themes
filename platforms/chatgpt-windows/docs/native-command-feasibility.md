# Native composer command feasibility (2026-11-08)

Goal: manage wallpaper through `/prism` inside ChatGPT and keep using the ordinary app icon. On 2026-11-08 the user accepted a one-time `/prism setup`, one app restart, and a small internal background component. Later wallpaper changes should apply live. A separate launcher or settings application is not part of the intended daily workflow.

## Evidence by gate

| Gate | Result | Evidence |
| --- | --- | --- |
| 1. Composer discovery | Passed for this installation | A user-scoped `prism` skill at `%USERPROFILE%\.codex\skills\prism\SKILL.md` was returned as enabled by `skills/list` with `forceReload: true`; the user saw Prism in the slash list and selected it in this already-open chat. The selected entry attached a skill reference to the message; the assistant read that skill and produced `PRISM_NATIVE_ENTRY_OK`. |
| 2. Local execution | Passed | A selected Prism invocation with `diagnostic` ran `node experiments/native-command/probe.mjs` in the project and returned `PRISM_LOCAL_EXEC_OK`, `expectedWorkspace: true`, and `projectName: prism-chatgpt`. This is agent-mediated execution, not an immediate built-in command handler. |
| 3. Renderer access through ordinary Windows activation | Passed in an isolated profile | `IApplicationActivationManager::ActivateApplication` launched the installed app through the Windows.Launch contract, with no debugging flags in the activation request. A temporary package-debug callback added CDP to the fresh marked process before its initial thread resumed. The resulting listener belonged to that process and bound only to `127.0.0.1`. The existing app processes remained alive. This is not yet a persistent installation in the normal profile. |
| 4. Live image change and restore | Passed in that isolated activation | The renderer displayed one local image, switched to a different image without restarting, changed dimming, and removed the wallpaper. The switched image hash and single wallpaper layer were checked, and a screenshot was visually inspected. |
| 5. Persistent setup and ordinary daily use | User acceptance and recovery milestone passed | The user's real setup and screenshot confirm signed-in Codex rendering. Lifecycle and recovery fixtures cover helper failures, repeated sessions, two visible native windows, compatibility pause, and live repair. Implementation version 2 is installed and reattached to the user's two views. Actual Windows login, hours-long sessions, and future updates remain unverified. See [reliability](reliability.md). |

## Interpretation

The composer command route and a Windows activation route are now both demonstrated. Together they provide a viable basis for the accepted setup-and-restart workflow. A small resident component would keep the package callback available, attach to new app windows, and reapply the saved wallpaper. The skill would manage that component and send wallpaper changes to an already prepared window. This does not provide a synchronous built-in command like `/usage`; invoking the skill runs an agent turn.

The development probes changed wallpaper only in fresh isolated profiles and cleaned up their temporary callbacks and processes. A later explicit user setup enabled the persistent helper, owned package callback, and login startup for the ordinary app. Subsequent status and user-supplied visual evidence establish the first signed-in normal-profile acceptance. The Prism skill routes to the implemented setup and wallpaper commands.

## Routes checked

The original [Claude Prism](https://github.com/f1ymango/prism-themes) uses Claude's `$.ui.backdrop` API where supported and, for images, a React DevTools extension slot enabled by `REACT_PROFILE=1`. This ChatGPT production build gates extension loading to unpackaged builds; a direct extension-loading experiment did not reach the app renderer. Its Chromium-switch environment setting is also restricted to development builds. Read-only inspection of the runtime's Electron fuse wire found `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` disabled. These are concrete reasons to avoid relying on environment injection or late Node debugger activation for the first ordinary window.

The documented appearance controls cover colors and fonts. Documented plugin extensions cover plugin-owned UI surfaces, without a host-wide image-wallpaper API. This is a limit of the interfaces examined, not proof that every conceivable method is impossible.

The [community Codex Glass Themes implementation](https://github.com/mabyes1/codex-glass-themes) supplied evidence for investigating package-debug callbacks. The independent local probe is in `experiments/native-command/activation/`. It uses the existing command-line buffer of a validated, newly activated x64 process and a short junction resolving to the same official executable; it adds no executable code to the target. Windows documents the process-parameter layout as subject to change, so compatibility checks are required.

Two initial attempts did not establish renderer access. Replacing the command-line buffer reached the callback but the child exited early; the cause of that exit was not established. A later executable-alias test failed path validation and resumed without modification. Switching to native package activation with an edit inside the existing buffer passed twice. Only those final native-activation runs count as successful evidence.

## Implementation and remaining acceptance

The first three implementation items—persistent setup, live commands, and saved-image application—are implemented and covered by the lifecycle fixture. The helper holds the Windows package-debug interface while enabled, validates the pinned build, and preserves registrations owned by another tool.

The first user-controlled normal-app restart and signed-in rendering check have passed. Dedicated isolated tests now also cover repeated sessions, two visible native windows, and helper recovery. Remaining acceptance includes actual Windows login, hours-long sessions, detached windows, other app views, and future app-update compatibility.

Package-debug mode changes Windows lifecycle behavior while enabled, and a loopback CDP endpoint gives local processes renderer access. These are real properties of this approach. Removal must disable the callback and explain that closing the already-enabled CDP endpoint requires a full app restart.

The successful probe summary is in `docs/evidence/native-activation.json`. Local full reports and the screenshot are under `.prism-probe/native-activation-c95e9eb8da9f4292a72d229e95f09af2/`.

## References

- [Slash commands](https://learn.chatgpt.com/docs/reference/slash-commands): enabled skills can appear in the slash list.
- [Build skills](https://learn.chatgpt.com/docs/build-skills): local skill discovery and invocation.
- [App Server](https://learn.chatgpt.com/docs/app-server): `skills/list` discovery contract.
- [Settings](https://learn.chatgpt.com/docs/reference/settings): documented appearance controls.
- [Plugin Extensions](https://developers.openai.com/plugins/build/extensions): documented UI extension surfaces.
- [Windows package debugging](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ipackagedebugsettings-enabledebugging): callback and lifecycle behavior.
- [Windows app activation](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-iapplicationactivationmanager-activateapplication): the normal launch contract used in the probe.
- [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses): disabled Node option and inspector features.
- [Process parameters](https://learn.microsoft.com/en-us/windows/win32/api/winternl/ns-winternl-rtl_user_process_parameters): layout and compatibility limit.
