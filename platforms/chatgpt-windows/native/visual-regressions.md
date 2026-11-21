# Recurring wallpaper visibility regressions

Keep this record when repairing the Windows integration after desktop app updates. It is installed beside the native helper so the Prism skill can find it even when the development checkout is unavailable.

## Symptoms and confirmed causes

| App build / Prism implementation | Symptom | Confirmed cause and repair |
| --- | --- | --- |
| 26.1103.4239.0 / version 5 | Dark boundary below the title and around the composer | Native `MainContentTopFade` and bottom-fade elements, footer backdrops, and header pseudo-elements needed scoped transparency rules. See the original [surface investigation](https://github.com/f1ymango/prism-themes/blob/main/platforms/chatgpt-windows/docs/surface-transparency.md). |
| 26.1117.4957.0 / version 9 | Wallpaper visible in the sidebar but covered by a solid conversation rectangle | The app replaced the old `MainContentSurface-` class with `data-app-shell-main-surface="default"` and added `data-app-shell-surface-backing="true"` under the workspace. Their width is smaller than the old whole-window threshold. A hidden full-window fallback also produced a false positive in surface counting. Mark the reviewed visible layers and exclude hidden fallback/code content. |
| 26.1117.4957.0 / version 10 | Dark horizontal band below the composer and a fade below the title | The `data-thread-scroll-footer` node is now inside a non-interactive wrapper whose `::before` draws the gradient and `::after` draws a solid bottom strip. Rules targeting the footer's children miss its parent. The top fade now uses `--app-shell-content-fade` class tokens. Clear only these decorative backgrounds/images/shadows, including both pseudo-elements. |

These are rendering regressions, distinct from the helper's deliberate pause on an unverified app package. Both can occur during the same update. Successful setup, an isolated image probe, or `appliedWindows > 0` alone is insufficient evidence of full visual restoration in the signed-in conversation view.

## Current reviewed targets

- Main background: `main[data-app-shell-main-surface="default"]`.
- Main backing: `[data-app-shell-workspace="true"] > [data-app-shell-surface-backing="true"]`, with pointer interaction disabled.
- Top decoration: `[data-app-shell-main-surface="default"] .pointer-events-none[class*="--app-shell-content-fade"]`.
- Composer decoration: `.thread-scroll-container > .pointer-events-none:has(> [data-thread-scroll-footer="true"])`, including `::before` and `::after`.
- Earlier supported selectors remain in `src/wallpaper-style.mjs` for older app layouts.

The composer input's `.vertical-scroll-fade-mask` clips scrolling text. Preserve it. Do not remove every gradient, mask, or background in the app to hide a band. Preserve native controls, code blocks, dialogs, dimensions, pointer behavior, and the user's chosen panel tint.

## Required checks for the next recurrence

1. Record the app package, active theme, helper state, and whether the defect affects the main surface, title area, composer area, or a panel. Back up preferences and the theme library before deployment.
2. Inspect the visible signed-in view's computed backgrounds, background images, masks, and `::before`/`::after` styles. Inspect the suspect node's parents and siblings too. Do not count invisible fallback shells as proof of a visible background surface.
3. Prefer reviewed semantic attributes and structural relationships. Record any new target here with the app build and the reason it is safe to restyle.
4. Reproduce the new structure in `scripts/native/test-surfaces.mjs`. The current fixture includes a narrow main surface/backing, hidden fallback, top fade, footer parent pseudo-elements, and an editor text mask. Assert computed transparency, preserved content/controls and bounds, and restoration after removing Prism.
5. Run the declared Node test suite, the isolated surface fixture, and the build compatibility probe. Renderer contract 3 requires both app-shell and decorative-fade transparency; earlier cached approvals must not skip the changed contract.
6. Inspect a fresh screenshot of the actual signed-in view at both the title and composer boundaries. Confirm the saved video is advancing and the theme, preferences, and library were preserved. State any unverified modes or views.

On 2026-11-21 the version-10 fix was checked on the Codex dark conversation view. Light mode and other app views require separate acceptance. Screenshots of personal conversations stay in ignored local artifacts rather than the public repository.
