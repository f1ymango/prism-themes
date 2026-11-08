# In-app wallpaper controls

Date: 7 November 2026 (Hong Kong)

## Delivered

The running Prism-enabled desktop app now has a compact Wallpaper button and a Ctrl+Alt+P shortcut. The panel contains a local file picker, appearance controls, and a bounded command field. Wallpaper changes no longer require returning to a shortcut or terminal once Prism is loaded.

Commands include choose, dim 40, fit contain, fit cover, position top, hide, show, and reset. An optional /prism prefix is accepted in this field. The parser accepts only explicit local actions and never executes shell text. It does not intercept or send the contents of ChatGPT's composer.

Selected image bytes and appearance settings are stored in the profile's namespaced IndexedDB database. The image is validated by its bytes and dimensions before replacing the current wallpaper. A bad file preserves the current image. A selected image can be restored after the renderer is reinjected.

The existing-window updater verifies the manager, process, package identity, build fingerprints, listener ownership, and Prism's DOM ownership. It can distinguish the owned window when the process has multiple app pages, preserves its image/settings, and updates the controls without closing or restarting the app.

## Verification

All 26 automated tests passed. The signed-in in-app proof passed:

- Commands and Ctrl+Alt+P.
- Image assignment through the panel's own HTML file input.
- Invalid-file recovery without replacing the selected image.
- Restoration of the selected image, dimming, and fit from local storage.
- Removal of the keyboard handler during cleanup.
- Listener closure, original-process preservation, and unchanged installed-file hashes.

The existing user-owned Prism window was then updated successfully without relaunching. Its current image and settings were preserved. Private reports:

- .prism-probe/in-app-controls-2026-11-07T15-50-04-327Z-bc47d1d8/report.json
- .prism-probe/open-window-update.json

The OS file chooser itself still needs a manual interaction check; the selection/validation/rendering pipeline was exercised by assigning files through CDP.

## Remaining normal-launch blocker

This does not yet provide Claude-style installation into an otherwise unprepared, normally launched ChatGPT window. That process currently exposes no debugging connection for this loader. A local extension probe loaded but did not inject its content script into the app UI. The failed injection is recorded as false in the probe report; a completed diagnostic run is not proof that this route works.

Official plugin documentation lists sidebar apps, panels, viewers, forms, and composer integrations, but does not establish a host-wide wallpaper API: [Plugin Extensions](https://developers.openai.com/plugins/build/extensions).

The remaining work is to prove and package a one-time normal-start loading mechanism. The in-app picker and commands are implemented independently of that mechanism so they can be reused when it is available. No startup registration or ordinary application shortcut was changed as part of this update.
