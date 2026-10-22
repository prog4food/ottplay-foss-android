# Documentation images

`hero.png` projects the existing `studio-2026-default.png` screenshot into a
16:10-style presentation area with a neutral background and a soft shadow.
The source is the Studio 2026 interface described in
[interface settings](../interface-settings.md); channel names, logos and
programme data are synthetic test fixtures. It is an existing design capture,
not a claim that every current platform or release looks identical.

The original is preserved unchanged and linked from the README. The renderer
changes geometry and the rounded outer corners only; it does not redraw text,
controls, programmes, or video. Keep instructional screenshots flat and legible.

## Regenerate

Install ImageMagick 7, then run from any working directory:

```sh
./scripts/render-docs-hero.sh
```

The script expects a 1280 × 720 input and stops if its dimensions change. Review
the projection and the README caption when replacing the source. Use an isolated
local demonstration with fixture data for future captures: exclude provider
accounts, URLs, personal channel lists, addresses, and browser chrome.
