# Surface transparency

For the update-by-update history, known selectors, and repair acceptance checks, read [recurring visual regressions](../native/visual-regressions.md).

Implementation version 5 addresses the opaque regions visible over the user's video wallpaper in the Codex dark view. These were native app backgrounds that the initial wallpaper stylesheet did not cover.

- The horizontal dark boundary below the conversation title was the native `MainContentTopFade` gradient.
- The black area around the composer was a footer backdrop, with an additional bottom scroll-fade sibling outside the footer.
- The grey composer and Outputs/Sources panel had independent opaque backgrounds. Outputs/Sources also had opaque sticky headers and header pseudo-elements.
- Resource cards used a separate raised-surface background.

`src/wallpaper-style.mjs` supplies an owner-scoped stylesheet for these reviewed elements. Composer, summary panel, and resource cards receive a 65% surface tint; their remaining 35% is transparent. Decorative top/bottom fades and footer backdrops become transparent. Summary headers and reviewed nested card backgrounds no longer add opaque blocks. No backdrop blur is introduced.

`src/wallpaper.mjs` serializes the stylesheet into the isolated renderer and refreshes it during apply/update/renew. Removing the owned stylesheet restores native styles; shared nodes receive no inline background edits. Dialogs, native buttons, code content, layout, and pointer behavior retain their styling. The change adds no dependency or preference-schema fields.

`scripts/native/test-surfaces.mjs` checks computed backgrounds in an owned isolated app, including the sibling bottom fade, nested summary headers, composer, resource cards, controls/code/dialog preservation, unchanged bounds/pointer behavior, and exact native-style restoration after removal. It passed, as did the existing 33 unit tests. Results are in `docs/evidence/surface-transparency.json`.

The installed upgrade preserved the selected MP4, preferences, and all original app processes. Only Prism's renderer helper was refreshed. Live computed-style checks and a renderer screenshot confirmed transparent fades/footer backdrops, approximately 0.65 panel/composer/card alpha, transparent summary headers, and continuing muted video playback. Status reported one applied visible view, one deferred hidden view, zero errors, and no restart requirement. Computed-style evidence is in `docs/evidence/surface-transparency-live.json`; the signed-in screenshot remains in ignored local artifacts.

Other app views and light mode have not been visually verified. The selectors deliberately cover reviewed surfaces on the current build; a future app redesign may require adjustments.

## App-shell layout in 26.1117.4957.0

Implementation version 9 recognizes `main[data-app-shell-main-surface="default"]` and the non-interactive `[data-app-shell-surface-backing="true"]` directly under the app workspace. These occupy the conversation area rather than the whole viewport. The previous whole-window size threshold missed them after the older `MainContentSurface-` class disappeared, leaving an opaque conversation rectangle over a working wallpaper.

Hidden fallback surfaces and code content are excluded from surface marking. Changes to the app-shell marker attributes trigger a refresh. The isolated surface fixture now reproduces a conversation surface that spans only 65% of the viewport, its separate backing, and a hidden full-window fallback; it checks transparency and exact restoration after removal.

Renderer approval contract 2 requires the reviewed app-shell layers to be transparent when present, so earlier cached approvals cannot skip this check. All 44 unit tests, the isolated surface fixture, and the stricter compatibility probe passed. Live checks on the signed-in Codex conversation confirmed both layers transparent, continuing Miku video playback, unchanged preferences/library, and no helper errors. The local screenshot remains in ignored artifacts. Light mode and other app views remain unverified.
