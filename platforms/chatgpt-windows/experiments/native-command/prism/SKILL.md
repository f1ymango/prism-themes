---
name: prism
description: Diagnose Prism wallpaper control from the ChatGPT desktop composer when the user invokes /prism or asks to test that route. This probe does not change the wallpaper.
---

# Prism command probe

This skill tests whether the desktop composer can route a user command to a local agent workflow. It is a diagnostic, not a wallpaper controller.

- If invoked with no argument, reply with `PRISM_NATIVE_ENTRY_OK`. State that the marker proves only that this skill's instructions were loaded. Do not claim that a built-in command was registered or that a wallpaper changed.
- If the user includes `diagnostic`, run `node experiments/native-command/probe.mjs` from the development project directory. Report the marker and checks the script returns. If the tool is unavailable, report that instead of inventing a result.
- Do not alter the installed app, normal profile, wallpaper, or launcher while this probe is active.
- Distinguish what was observed in the composer from what the user reported. The text `/prism` in a normal message is not, by itself, evidence that the slash menu exposed this skill.
