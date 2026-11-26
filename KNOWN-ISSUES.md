# Known issues

Live wallpapers run on Claude Desktop's official backdrop: one Svg (at most 131,072 characters) drawn under one
plugin Shader. This page lists what we know goes wrong or costs more than it should, why, and what helps. Measured on
Claude Desktop 6.28899 with Claude Code 2.1.330 (Windows 11; an Intel UHD integrated GPU and an RTX 5050).

## In Claude Desktop (Prism can only work around these)

**After a quick restart, the wallpaper stays a still picture for up to about 5 minutes.**
While a shader plays, the page stamps `backdrop-shader-playing-at` in its local storage every 250 ms and clears it
only on pause, blur or page hide, not on quit. A new player that finds a stamp 3 s to 300 s old takes it as a lost
GPU and starts no shader. *Workaround (since 0.10.38):* Prism notices the rest and redraws the wallpaper once it is
over, so it starts playing by itself.

**Every session switch redraws the wallpaper from scratch.**
The backdrop is mounted with the session id as its key, so switching sessions tears down the player and starts a new
one, and shaders keep no state between players. The live keyframe is collected and decoded again: a blurred preview
after about half a second, the sharp picture after about 14 s. *No workaround.*

**A live wallpaper costs GPU time while it is visible, even when held still.**
About half of an integrated GPU (Intel UHD) or about 12% of a discrete one, plus copy traffic when the display hangs
off another GPU. The live keyframe's data travels as an animated Svg, and the page keeps sending an animated Svg to
the player, which keeps it drawing. `/prism motion off` holds the picture still but does not lower this. It stops when
the window is minimised or hidden. *Workaround:* a static theme on battery.

**Dragging the window's size stretches the wallpaper until you let go.** The player pauses around a resize and shows
its last frame scaled. It is correct again on release.

**The plugin validator passes shaders that Desktop refuses or miscompiles.** Notes for anyone writing shaders:
- A shader with 20 passes (buffers, the picture pass and tables) was refused without a message; 18 works.
- GPUs compute in float32. `v + 0.5` is not exact once `v` reaches 2^23, and `floor(a / n)` or `mod(a, n)` can land
  one off for whole numbers when `n` is not a power of 2 (use `floor((a + 0.5) / n)`).
- A flag kept in a `let` across a run-time `for` loop with a ternary was read as already set by Desktop's compiled
  shader; unrolling over `range()` and multiplying 1/0 values works.
- The validator's sharpness verdict sits on a cost total: small changes can flip a shader to "needs a fast GPU". Word
  reads inside big passes are the usual cost; decode them once in a small pass.

**Windows needs Transparency effects on, and shaders stop when Animation effects (reduced motion) are off.** These are
Desktop's rules.

## In Prism's live wallpapers

**When no shader runs, the bare Svg shows a flat colour with a blinking grid of cells top left.** The cells are the
data channel (16.5 s of changes, then 20 s still, repeating). Desktop shows the bare Svg when it refuses or stops a
shader, during a rest after a quick restart, and on GPUs too weak for the shader. Only a few hundred characters are
free in the Svg, enough for a colour gradient, not a picture.

**Content that appears cannot be drawn, and straight lines near it can bend.** The motion warps one keyframe. A
curtain sliding over a window or hair uncovering a wall shows things the keyframe does not have, and the warp
stretches what is there instead. Layers (`--layers`) keep a moving figure from dragging its background along; the
light term (`--light`) covers brightness changes. Neither can draw what the keyframe never showed.

**The light term works with one motion field only.** A theme with layers on leaves it out.

**Old video-file themes draw nothing on the official route.** Convert the video with the `make-live-wallpaper`
skill.

**The keyframe encode takes minutes.** It spreads over the machine's cores: about 3 minutes with 12 or more threads,
up to a quarter of an hour on one. `--quick on` encodes in under a minute at lower quality, for checking.
