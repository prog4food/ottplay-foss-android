# Runtime asset names

Project-owned paths describe the resource or adapter they contain. The same
layout is used by the browser player, the Rust server, the Mode A archive,
Tauri and the retained Capacitor frontend.

- `dist/player.js` is the compiled ES5 player entry point, formerly
  `dist/stbPlayer.js`.
- `styles/player.css` contains the responsive interface and themes, formerly
  `stbPlayer/1280.css`. It is not tied to a 1280-pixel display.
- `images/player-logo.png` is the startup artwork, formerly
  `stbPlayer/icon.png`. Native distributions can exclude this artwork.
- `locales/english.js`, `locales/russian.js` and the other English-named language
  files replace `stbPlayer/_*.js`. `src/localization/assets.ts` resolves the
  existing saved language identifiers to these paths. Language order, dictionary
  keys, translations and keyboard alphabets are unchanged.
- `devices/<device>/device.js` and `src/devices/<device>/device.ts` replace
  `stb/<device>/stb.js` and `src/stb/<device>/stb.ts`.
- `providers/<provider>/` replaces `prov/<provider>/`. Retained provider source
  files are named `provider.js`; migrated provider implementations continue to
  ship as the `dist/provider-*.js` bundles. Historical source oracles, including
  `devices/legacy-core.js`, are excluded from release packages.

The TypeScript modules `key-handler`, `settings/sleep-timer`,
`plugins/m3u-user-agent` and `utils/qr-code` use descriptive, hyphenated names.
Their public functions and stored callback identifiers have not been renamed.
Third-party library filenames, tool-required filenames, device identifiers and
provider brand identifiers retain their established names. References to the
original inherited filenames in provenance documents describe their history.

Dealer-provided extensions are external resources, not renamed project files.
Their compatibility URLs remain `/prov/<id>/prov.js`, `/prov/<id>/logo.png`,
and `/prov/<id>/about<saved-language-code>.html` (English has no suffix).
Built-in provider descriptions and logos use the new `providers/` layout.

## Updating a deployment

Install the complete web root and matching Rust server binary together. Updating
only the HTML or player script can leave the new resource URLs unavailable.
Custom static servers must expose `dist`, `styles`, `images`, `locales`,
`devices`, `providers`, `fonts` and `js` at the web root. The existing
`/f/<device>/` entry URLs and saved player settings continue to work.

Build staging removes retired asset directories and the previous entry bundle.
When updating an existing installation, back up and retire its old `stbPlayer`,
`stb` and `prov` asset directories and `dist/stbPlayer.js`; preserve operator
configuration, profiles, playlists, certificates and local data. Use a complete
release archive instead of overlaying individual renamed files. Refresh open
browser pages after installation so their bootstrap uses the new asset paths.

The release filenames and metadata fields remain stable for existing downloaders.
Mode A packaging, native staging, browser tests, server route tests and emitted
bundle checks validate the new paths.
