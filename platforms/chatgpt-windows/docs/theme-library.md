# Saved theme combinations

The native integration automatically remembers the latest combination for each wallpaper in `%LOCALAPPDATA%\PrismChatGPT\state\themes.json`. Each entry includes the owned wallpaper file, font/palette settings, panel opacity and corners, dimming, fit, and position. Selecting a known wallpaper restores its combination. The original input file is not needed after Prism copies it into its wallpaper store.

Use `/prism theme list` to see names and IDs, `/prism theme save "Tea Party"` to name the current combination, and `/prism theme use "Tea Party"` to restore it. Name matching ignores case. An unambiguous ID prefix also works. Save captures the resolved automatic palette and font when a prepared window has confirmed them. Automatic entries remain valid before a renderer is ready; they derive their palette from the saved media when displayed.

Changes update the wallpaper's existing entry. There is one remembered combination per wallpaper, up to 256 wallpapers. Naming an entry renames that remembered combination. A damaged library or missing/changed saved file is reported before replacing the active preferences. Removal retains the library and wallpapers.

## Native UI boundary

The official [plugin extension reference](https://developers.openai.com/plugins/build/extensions) provides plugin panels, settings, and composer mentions. It does not document a persistent theme-control strip above the prompt. Prism's native skill therefore uses commands for its library. No custom strip is injected into the composer. A separate supported plugin panel would require a plugin/MCP integration and is not included here.

## Startup readiness

The Windows activation callback now checks the worker's state, process identity, package, and heartbeat. If the owned installation is enabled but the worker is not ready, it starts the existing hidden supervisor and waits up to 12 seconds. It reloads the worker's checked configuration before preparing that first activation. A timeout, disabled installation, removal request, or build mismatch preserves ordinary app activation.

The worker no longer disables its existing owned callback immediately before rearming it. The activation age window accommodates a newly started app waiting for the helper. The automated fixture covers delayed readiness, healthy reuse, disabled/removal state, and bounded failure. A real sign-out/reboot and first launch still require user acceptance; these tests do not reproduce Windows login ordering or an OS update clearing package registrations.
