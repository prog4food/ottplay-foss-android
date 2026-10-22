# Device Profile Development

This guide documents how to add a new device profile (remote control key mappings) and provider script for the `ottplay-foss` player.

For regression checks and an official LG Simulator launcher, see
[Device detection and emulator testing](device-detection-testing.md).

## 1. Adding a New Device Profile

Device profiles live in `src/devices/` and define the remote control key codes for a specific STB platform. Each profile is a JavaScript file named `{device-name}/device.js` containing a `keys` object mapping symbolic key names to platform-specific key codes.

### File: `src/devices/{device}/device.js`

**Required structure:**

```javascript
version += ' {device}-0219';
var keys = {
    // Navigation keys
    RIGHT: <code>, LEFT: <code>, DOWN: <code>, UP: <code>,
    // Action keys
    RETURN: <code>, EXIT: <code>, TOOLS: <code>,
    // Media controls
    FF: <code>, RW: <code>, NEXT: <code>, PREV: <code>,
    ENTER: <code>,
    // Color/action keys
    RED: <code>, GREEN: <code>, YELLOW: <code>, BLUE: <code>,
    // Channel keys
    CH_LIST: <code>, CH_UP: <code>, CH_DOWN: <code>,
    // Number keys
    N0: <code>, N1: <code>, ... N9: <code>,
    // Pre-charge
    PRECH: <code>,
    // Power/playback
    POWER: <code>, PLAY: <code>, STOP: <code>, PAUSE: <code>,
    // Info/other
    INFO: <code>, REC: <code>, MUTE: <code>,
    // Volume
    VOL_UP: <code>, VOL_DOWN: <code>,
    // Optional (set to 0 if not present)
    ZOOM: <code>, ASPECT: <code>, AUDIO: <code>, SETUP: <code>,
    PIP: <code>, LANG: <code>
};
```

**Key conventions:**
- Use standard key codes per platform (see existing profiles for reference)
- If a key is not present on the device, set its value to `0`
- The `version` line should follow the pattern `version += ' {device}-0219'` — update the suffix if the device has a different version scheme
- Keep alphabetical order within logical groups for readability

### Adding a new device:

1. Create directory `src/devices/{device}/`
2. Copy an existing profile as a template (e.g., `android/` or `hbbtv/`)
3. Replace the key codes with the correct values for your target device
4. Update the `version` line if needed
5. Verify the module loads correctly: `npm run typecheck`

### Profile directory listing (as of this writing):

| Device | Notes |
|---|---|
| `android` | Android TV / Google TV — uses Android keycodes |
| `android2` | (see `pc2`) |
| `core.js` | Shared STB implementation (not a device-specific profile) |
| `dune` | Dune HD media players |
| `e2` | Enigma2 (Linux-based satellite receivers) |
| `edem` | Edem STBs |
| `hbbtv` | HbbTV-compliant smart TVs |
| `hisense` | Hisense TVs |
| `inext` | Inext STBs |
| `lg` | LG WebOS / NetCast TVs |
| `mag` | MAG set-top boxes |
| `mag2` | (see `pc2`) |
| `nodejs` | Node.js-based STB emulation |
| `pc` | PC browser |
| `pc2` | PC browser with Video.js 7 / VHS 2 |
| `panasonic` | Panasonic Viera TVs |
| `philips` | Philips TVs |
| `sharp` | Sharp Aquos TVs |
| `skyworth` | Skyworth TVs |
| `sony` | Sony Bravia TVs |
| `spark` | Spark STBs |
| `tcl` | TCL TVs |
| `toshiba` | Toshiba TVs |
| `vewd` | Vewd smart TV platform |
| `samsung` | Samsung Tizen / Maple SDK TVs |

## 2. Adding a New Provider Script

Provider scripts handle IPTV playlist parsing and live in `providers/`. Each script is a JavaScript file named `{provider-name}/provider.js` that exports parsing functions for a specific IPTV service.

### File: `providers/{provider}/provider.js`

**Required structure:**

```javascript
version += ' {provider}-0219';
p_pref = '{provider}';
// Optional: parental control regex
parental = /XXX|Взрослые|Для взрослых|Эротика|18\+|Adults/i;

// Optional: stubs if globals not available
if (typeof stbGetItem === 'function') {
    providerGetItem = function(e) { return stbGetItem(p_pref + e); };
    providerSetItem = function(e, r) { stbSetItem(p_pref + e, r); };
} else {
    providerGetItem = function(e) { return localStorage.getItem(p_pref + e); };
    providerSetItem = function(e, r) { localStorage.setItem(p_pref + e, r); };
}
providerDelItem = function(e) { return ottpStorage.del(p_pref + e); };
providerHasItem = function(e) { return ottpStorage.has(p_pref + e); };
providerHasItemValue = function(e) { return ottpStorage.hasValue(p_pref + e); };

// Provider object with config and functions
var {providerName} = {
    // Configuration
    portal: '',    // Portal URL (for Stalker/Ministra)
    mac: '',       // MAC address
    token: '',     // Authentication token
    data: null,    // Cached data

    // Data accessors
    getChannelPicon: function(e) { return chanels[e] ? chanels[e].logo || '' : ''; },
    getChannelUrl: function(e) { return chanels[e] ? chanels[e].url || '' : ''; },

    // Archive URL builder
    getArchiveUrl: function(e, r, t) {
        // ... replace ${start}, ${end}, ${timestamp}, ${offset}, ${duration}
    },

    // EPG fetch
    getEPGchanel: function(s, e) {
        // ... fetch EPG data for channel s, call callback e with (channel, data|null)
    }
};
```

**Key conventions:**
- The `version` line follows `version += ' {provider}-0219'` pattern
- `p_pref` is the localStorage key prefix — use the provider name in lowercase
- If `stbGetItem` global exists, use it for storage; otherwise fall back to `localStorage`
- Always export `providerDelItem` and `providerHasItem`/`providerHasItemValue` for storage management
- Add `parental` regex if the provider has adult content filtering

### Provider directory listing (as of this writing):

| Provider | Type |
|---|---|
| `dragon` | Generic/Dragon IPTV |
| `edem` | Edem IPTV |
| `fabryka` | Fabryka IPTV |
| `fox` | Fox IPTV |
| `fxml` | FXML IPTV |
| `great` | Great IPTV |
| `ipstream` | Ipstream IPTV |
| `iptv-ott.ru` | Russian IPTV |
| `itv` | General IPTV |
| `kb-team` | KB Team IPTV |
| `korona` | Korona IPTV |
| `m3u` | Generic M3U parser |
| `moidom` | Moidom IPTV |
| `newlook` | Newlook IPTV |
| `only4` | Only4 IPTV |
| `ottclub` | OttClub IPTV |
| `ottg` | OttG IPTV |
| `ottprime` | OttPrime IPTV |
| `polmedia` | Polmedia IPTV |
| `prost` | Prost IPTV |
| `raduga` | Raduga IPTV |
| `rd` | RD IPTV |
| `shara-tv` | Shara TV IPTV |
| `shara.club` | Shara Club IPTV |
| `sharavoz` | Sharavoz IPTV |
| `shocktv` | ShockTV IPTV |
| `shura` | Shura IPTV |
| `stalker` | Stalker/Ministra middleware |
| `tabox` | Tabox IPTV |
| `top` | Top IPTV |
| `topiptv` | Topiptv IPTV |
| `ultifl1x` | Ultifl1x IPTV |
| `vidok` | Vidok IPTV |
| `xtream` | Xtream Codes API |
| `xui` | Xtream UI (if present) |

### Adding a new provider:

1. Create directory `providers/{provider}/`
2. Copy an existing provider script as template (e.g., `stalker/` or `xtream/`)
3. Replace the `version` line and `p_pref` value
4. Update the provider-specific functions (portal URL format, API endpoints, etc.)
5. Add `parental` regex if needed
6. Verify by loading the player and selecting the provider

## 3. Linting Provider Scripts

Run the project's biome linter to check all provider scripts and device profiles:

```bash
npm run lint
```

Or fix issues automatically:

```bash
npm run lint:fix
```

### Custom checks added:

The biome config (`biome.json`) already enforces style rules via the `ultracite/biome/core` extended config. Additional provider-specific validations can be added via a pre-commit hook or CI check.

**Recommended:** Add a pre-commit hook that runs biome check on `providers/**/provider.js` and `src/devices/**/device.js` files only, to catch obvious issues without full project lint on every commit.

See `.pre-commit-config.yaml` for the project's existing pre-commit configuration.

## PC2 playback

`/f/pc2` and `/f/pc2/` select the optional Video.js 7.21.7 / VHS 2.16.3
engine. They keep the PC keyboard map, common UI, provider settings and device
identity. They do not select another account or change the saved `sPlayers`
preference used by `/f/pc`. The engine-choice row is hidden while Video.js is
active, since that URL explicitly selects its engine.

The executed adapter is `devices/pc2/device.js`; `src/devices/pc2/device.ts` retains the typed
keyboard reference. The HTML bootstrap loads `js/video.min.js` and
`devices/pc2/player.css` only for PC2, after the shared compatibility runtime.
Ordinary PC keeps its existing native/HLS.js/Shaka choices. If the optional
vendor fails to load, PC2 visibly logs the fallback and boots those same choices.

See [PC2 engine and compatibility](pc2-videojs.md) for lifecycle, polyfills,
version provenance, CSP requirements and tests.
