# Interface languages and on-screen keyboard alphabets

## Translation catalog

`locales/english.js` is the canonical interface dictionary. The other 87 language
packs contain the same keys; `lang` and the historical `alhabet` spelling are
locale metadata. Existing language codes and the first 58 selector positions
are preserved. Translations were completed with machine/AI assistance and checked for
key and formatting consistency; these checks do not replace native-speaker
editorial review.

Language packs use descriptive English filenames under `locales/`.
`src/localization/assets.ts` is the shared map from persisted identifiers such
as `_eng` and `_rus` to `/locales/english.js` and `/locales/russian.js`.
Both runtime loaders and the catalog/packaging checks use this map. Existing
saved preferences and keyboard locale identifiers are unchanged; an unknown
identifier loads English. The catalog audit verifies a one-to-one relationship
between the selector, the asset map, and all 88 shipped files.

Translate the canonical English values with their UI context; historical keys
can be ambiguous. `Login` labels a provider username field, while `on ` prefixes
the ENTER button in the channel preview setting. `Resume from archive?` means
continue playback; `Search programme` refers to a broadcast programme, and
`left` is a screen position. These are not sign-in actions, power states,
résumés, search software or remaining quantities.

`scripts/localization-catalog.cjs` derives keys from translation calls, settings
labels, menu definitions, provider schemas and shipped device/provider scripts.
`scripts/localization-dynamic.json` records the reviewed boundaries for dynamic
values such as provider names and EPG metadata. New unresolved expressions fail
the audit instead of silently becoming an untracked fallback. English remains
the readable fallback for runtime data that is not a fixed UI key.

Run `npm run test:localization` for key/placeholder/HTML/whitespace parity,
keyboard alphabets, Unicode behavior, media preferences and the phone page.
English values in another language now fail the semantic audit unless the exact
locale/key/value is reviewed in `scripts/localization-identical.json`. Shared
exceptions are limited to brands, protocol identifiers and symbols; legitimate
short cognates use locale-specific exceptions. A new paragraph cannot inherit
a blanket English fallback. Cloud failure wrappers and the phone page's finite
vocabulary are scanned at their call sites. `npm run check:bundle` repeats keyboard behavior
against the actual ES5 bundle and verifies that server, Tauri and Capacitor
packages retain every dictionary and the Unicode license. Browser tests in
`npm run test:native:ui` cover remote/pointer paging and layout across Classic,
PLi-HD and Studio, list densities 10/25/30, and 640×360 through 3840×2160.

## Generated labels and original content

Bootstrap loads the saved language's existing catalog before showing startup
messages. Without a saved choice, it selects the first supported language from
the native preference list (Tauri and Capacitor iOS), or `navigator.languages`
in browsers. Older engines fall back to `language`, `userLanguage`, then
`browserLanguage` when no preference list is available. A nonempty list is
authoritative: unsupported entries do not trigger a different browser fallback.
Native preferences are injected at document start, before the HTML loader;
this avoids WebKit's reduced browser-language list. Injection is limited to the
trusted main player origin: bundled assets, the explicitly configured player
server, and Tauri's configured dev URL in development; other navigations and
subframes receive no native language list. The archived Android bridge
fixtures are not a shipped Capacitor target in this repository.
On Linux, an effective `C`/`POSIX` message locale (including encoding suffixes)
selects English ahead of `LANGUAGE` and WebView preferences; the first nonempty
`LC_ALL`, `LC_MESSAGES`, then `LANG` determines that locale.

BCP 47 tags are matched case-insensitively, accepting underscore separators and
region variants. The matcher retains explicit writing systems and the regional
script defaults from pinned CLDR 48 `likelySubtags.xml` (recorded in
`tests/fixtures/startup-locales.json`). It does not select a dictionary written
in another script: for example, `zh-Hant`, `pa-PK` and `sd-Deva` remain
unsupported unless a later preference has a matching pack. Legacy aliases
`iw`, `in`, `tl`, `nb`, `mo` and Kurmanji `kmr` map to their shipped catalogs.
The resolver needs neither `Intl` nor a network service.

The language picker includes **System language** and a search row. Search matches
both English and native language names and keeps selection tied to language codes
when the results change. A first successful automatic choice enables System
language; later launches re-evaluate the native/browser preferences. A manual
language remains fixed until the user chooses System language. Pre-existing saved
languages without a mode remain manual, so upgrades do not change them.

`ottplaylangmode=system` records that choice; `ottplaylang` keeps the last
successfully loaded effective language. The two are persisted only after a
successful load. Device/native bridge initialization also runs when startup has
to show the manual picker. Without a match or after load failure/timeout, startup
continues to that picker. Retrying the same saved language still loads its
dictionary if the earlier attempt failed; only a successfully active dictionary
can be reused. All dictionary attempts have bounded timeouts; cancelled
or late callbacks cannot replace the current dictionary or launch twice. If
localStorage rejects a write, the fresh cookie fallback takes precedence on the
next launch instead of resurrecting a stale language. Override metadata is split
into bounded cookies, with an incomplete marker written before its parts and a
complete marker committed only after reading back the persisted parts. Legacy
single-cookie lists remain readable. Interrupted or rejected metadata cannot
reactivate stale native values; startup and the running player use cookie/session
fallback until an explicit successful native clear. Internal marker keys never
enter settings backups or imports. If fallback cookies or their metadata cannot be written, changes may remain
session-only; persistence across restart cannot be guaranteed. A previously
committed cookie override can remain authoritative after restart if its metadata
cannot be updated, even when a native write succeeds. Capability detection also
tolerates denied access to localStorage.

The filename allowlist is checked against the canonical asset map. The picker
preserves the current dictionary on cancellation or failure. Tauri and Capacitor
dialogs receive the player's labels. Successful activation sets the effective
language for date/number formatting, TMDb requests and classic Stalker portal
cookies; all 88 codes share the same metadata map. External services may return
fallback content when they do not provide a translation.

Audio and subtitle preferences are separate from interface language in managed
player settings. **Player default** preserves the stream/engine choice; subtitles
also offer **Off**. An existing per-channel choice wins over a language default.
Manual selection stays in force for the current playback session, including VOD,
and late track events cannot override it. Matching uses manifest language tags
and common ISO 639 aliases; absent matches leave the engine choice intact.
These aliases follow the [ISO 639-2 code list](https://www.loc.gov/standards/iso639-2/php/code_list.php),
including bibliographic `fre`/`rum` and Latvian `lav`. Persisted interface IDs
are not ISO codes: `_lat` selects Latvian, while a media tag `lat` means Latin
and must not satisfy a Latvian preference.
Subtitle matching respects known writing-system differences. These preferences
are available to the shared HTML5/HLS/Video.js track interface; retained device
engines without that interface keep their own controls.

The hosted phone input page has a finite dictionary subset for every language.
It first uses the browser preference, then the successful TV pairing supplies the
player's language inside the existing encrypted offer. Only same-origin catalog
assets can be loaded. Hashed filenames keep the page and its dictionary bytes
consistent; late requests cannot revert a newer language. Instructions and
statuses are translated, while the private link stays LTR and entered text uses
its own direction.
An empty caption from an older TV offer remains a live translated label while
the browser dictionary loads; a caption supplied by the TV remains literal text.

Resolve interface labels when displaying them, including retained media frames,
provider menus and native dialogs. Placeholder arguments are literal content:
channel names containing `$&` or `%2` must not become replacement instructions.
Remote-command results and touchscreen-lock notifications use the same catalog.
The `popup_message` command preserves the sender's text verbatim; notification
text uses automatic direction and is never interpreted as HTML. Command names,
numeric arguments and machine-readable response statuses remain unchanged.

Generated media titles and the default favorites list carry provenance separate
from their stored names. Only marked defaults change with the interface language.
Explicit provider titles and user names remain unchanged, including a list that
the user calls `Favorites`. Older multi-list records without provenance retain
their literal names; their origin cannot safely be inferred from spelling.
Backups preserve the default-list marker, and renaming a list makes its name
user-authored.

The privacy policy and historical attribution text retain their authored English
content and are identified as such in the selected interface language. Their
surrounding titles, instructions and controls are localized. License notices and
external programme/provider metadata are original content, not interface keys.

## Alphabet contract and source

The versioned fixture in
[`tests/fixtures/locale-alphabets.json`](../tests/fixtures/locale-alphabets.json)
records the keyboard alphabet and required characters for every interface
language. Its source is **Unicode CLDR 48**, pinned to release commit
[`acd6d88ae493633240e19a87a721076a8a75c310`](https://github.com/unicode-org/cldr/tree/acd6d88ae493633240e19a87a721076a8a75c310).
Each entry links directly to that locale's original XML file and preserves its
main exemplar expression for review.

`alphabet` is the ordered lowercase string for the historical `alhabet`
translation key. `requiredCharacters` is an independent coverage set: every
character must be available through the localized lowercase/uppercase layouts
or the built-in Latin layout. It includes uppercase dotted `İ` where CLDR
explicitly requires it; that character belongs on the uppercase layout.
`requiredUppercase`, where present, records additional case-sensitive checks.
The English interface deliberately retains Russian as its secondary layout;
the built-in English layout already supplies `a` through `z`.

The contract covers CLDR's main exemplar for the selected writing system,
including precomposed accents, plus the explicit additions documented below.
CLDR's braces represent sequences such as Czech `ch`, Hungarian `dzs` and
Uzbek `oʻ`: users enter those with successive letter keys. Existing extra
letters are retained. The fixture is not a claim to support every historical
spelling, foreign proper name or auxiliary character in Unicode. The
[LDML character specification](https://www.unicode.org/reports/tr35/tr35-general.html#Character_Elements)
defines the distinction between main and auxiliary exemplars.

Specific additions and input details:

- Armenian includes the customary ligature `և`, present in CLDR's auxiliary
  exemplar. The canonical alphabet order is retained.
- Belarusian and Ukrainian include the modifier-letter apostrophe `ʼ`
  (U+02BC). ASCII `'` remains available in punctuation.
- Bulgarian includes the accented pronoun `ѝ` from the auxiliary exemplar.
- German includes `ä` and `ß`; Hebrew includes all five final letters
  `ך ם ן ף ץ`; Portuguese includes `ò`.
- Greek includes final sigma and every modern accent/diaeresis combination
  in its main exemplar.
- Uzbek distinguishes `ʻ` (U+02BB) in `oʻ` and `gʻ` from `ʼ` (U+02BC), and
  provides `c` so `ch` can be entered without switching layouts.
- Dutch includes U+0301 COMBINING ACUTE ACCENT to enter `íj́`: Unicode has no
  precomposed accented `j`. The keyboard label can show a dotted circle as a
  visual aid, while the inserted text must contain only the combining mark.
- Vietnamese includes all 89 main-exemplar characters, including every
  precomposed tone-marked vowel and `đ`. The Latin layout supplies the auxiliary
  `f`, `j`, `w` and `z` used in foreign words.

## Case changes must preserve key identity

Always derive a case change from the unchanged lowercase alphabet. Do not
recreate lowercase keys by lowercasing the uppercase output. Unicode case
mapping can expand one key into several code points or map several distinct
keys to the same uppercase text:

- German `ß` normally uppercases to `SS`.
- Armenian `և` uppercases to `ԵՒ`.
- Greek `ΐ` and `ΰ` uppercase to a capital vowel plus combining marks; both
  `σ` and `ς` uppercase to `Σ`.
- Turkish and Azerbaijani require the two distinct pairs `i`/`İ` and `ı`/`I`.

A key may insert a multi-codepoint string without changing the number or
identity of keys. Returning to lowercase must recover exactly the original
alphabet. These rules follow the
[Unicode 17 special-casing data](https://www.unicode.org/Public/17.0.0/ucd/SpecialCasing.txt);
locale-sensitive Turkish/Azerbaijani casing is necessary even when the browser's
ambient locale is English.

The keyboard offers `ẞ` on the uppercase German layout. Long alphabets use
pages of at most 40 letter cells, plus digit and control rows. The previously
unused control cell now shows a page counter and advances to the next page;
the final page wraps to the first. Both cell width and available panel height
constrain the rendered keys. The input preview scrolls to its caret without
changing stored font or list-density preferences.

## Additional interface languages

The new entries are appended after the existing languages: Indonesian,
Vietnamese, Malay, Dutch, Czech, Swedish, Azerbaijani and Kazakh. Existing
language positions remain stable. Malay uses Latin Rumi, Azerbaijani uses Latin,
and Kazakh uses Cyrillic, matching the selected CLDR main exemplars. These
choices do not claim support for Malay Jawi or an alternative Kazakh script.

The countries are sizeable enough to make these useful additions, with 2024
populations of approximately 283.5 million (Indonesia), 101.0 million
(Viet Nam), 35.6 million (Malaysia), 18.0 million (Netherlands), 10.9 million
(Czechia), 10.6 million (Sweden), 10.2 million (Azerbaijan), and 20.6 million
(Kazakhstan). These are country populations, not counts of speakers or users.
The source is the World Bank population indicator `SP.POP.TOTL`, queried on
2026-09-26: [Indonesia](https://api.worldbank.org/v2/country/ID/indicator/SP.POP.TOTL?date=2024&format=json),
[Viet Nam](https://api.worldbank.org/v2/country/VN/indicator/SP.POP.TOTL?date=2024&format=json),
[Malaysia](https://api.worldbank.org/v2/country/MY/indicator/SP.POP.TOTL?date=2024&format=json),
[Netherlands](https://api.worldbank.org/v2/country/NL/indicator/SP.POP.TOTL?date=2024&format=json),
[Czechia](https://api.worldbank.org/v2/country/CZ/indicator/SP.POP.TOTL?date=2024&format=json),
[Sweden](https://api.worldbank.org/v2/country/SE/indicator/SP.POP.TOTL?date=2024&format=json),
[Azerbaijan](https://api.worldbank.org/v2/country/AZ/indicator/SP.POP.TOTL?date=2024&format=json),
and [Kazakhstan](https://api.worldbank.org/v2/country/KZ/indicator/SP.POP.TOTL?date=2024&format=json).

## Thirty additional languages

Thirty further packs append to those 28 stable selector positions: Arabic,
Simplified Chinese, Japanese, Korean, Persian, Hindi, Bengali, Urdu, Punjabi,
Marathi, Telugu, Tamil, Gujarati, Kannada, Malayalam, Nepali, Sinhala, Thai,
Burmese, Khmer, Swahili, Filipino, Finnish, Danish, Norwegian Bokmål, Estonian,
Slovak, Slovenian, Croatian and Serbian. Punjabi uses Gurmukhi and Serbian uses
Cyrillic. Norwegian Bokmål inherits its CLDR exemplar from `no`.

Each new pack translated the original 806 canonical entries. The initial translations
used Google Translate on the public English UI text, followed by AI-assisted
editing of controls, playback/catch-up terminology, settings, HTML fragments,
days, units and remaining English prose. Proper names, protocols and identifiers
remain literal. Structural validation checks every entry, but does not certify
linguistic fluency; native-speaker review is still welcome.

The new keyboard inventories include every CLDR main-exemplar character and
explicitly documented additions: dependent vowels, viramas, diacritics, local
digits and punctuation. Malayalam also includes its auxiliary vowel signs and
chillu letters; Urdu includes noon ghunna and additional hamza forms. Direct
encoded variants such as Punjabi ਸ਼ and Bengali ড় remain reachable alongside
their combining sequences, and channel search treats canonically equivalent spellings alike. Shaping
controls ZWNJ/ZWJ have visible key labels. Combining marks show a dotted circle
only on the key; inserted text retains its original logical Unicode sequence.
The fixture preserves source expressions, additions and writing-system choices.

### CJK and native composition

The Chinese, Japanese and Korean inventories retain all 2,210, 2,311 and 11,172
CLDR main-exemplar characters respectively, plus the fixture's additions. They
are literal character inventories, **not** a phonetic conversion dictionary or
all historical/rare Unicode ideographs. The classic renderer can page through
them if native input is unavailable, but CJK normally opens the existing native
text field even on TV devices. Server, Tauri and Capacitor already use that field.

Full phonetic CJK input uses the platform's installed IME and its candidate UI;
remote text entry from a phone is another existing route. A device without a
usable system IME cannot gain Chinese/Japanese conversion from the literal grid.
No bundled conversion engine or remote-only predictive CJK IME is added. Font
coverage and shaping still depend on the device's fonts and text engine.

During composition, candidate Enter/Escape/arrows keep their browser behavior
and cannot save or switch the editor. The browser owns the field value; the
application never appends `compositionend.data`. Once composition has been used
in an editor session, saving requires the existing explicit Set control:
Enter in the field continues to belong to the IME, including after
`compositionend`. Down cycles through the field, remote text entry and Set;
Up moves back. This avoids a timing-based guess that can either submit a
candidate or swallow the next intentional Enter. Closing the editor removes its
composition listeners. Native input uses `dir="auto"` and never adds direction
controls to the stored value; ordinary URLs retain their LTR first character.

Automated tests verify the full inventories, marks/joiners, source and packaged
catalogs, and composition event handling in Chromium and WebKit for Server,
Tauri and Capacitor profiles. Synthetic composition events are not a substitute
for testing an installed IME on each supported physical device.

## Eighty-eight language packs

Thirty further languages append to the existing 58 selector positions: Georgian,
Albanian, Bosnian, Macedonian, Icelandic, Catalan, Basque, Galician, Irish,
Maltese, Pashto, Kurdish, Tajik, Kyrgyz, Turkmen, Mongolian, Lao, Odia,
Assamese, Sindhi, Afrikaans, Amharic, Hausa, Yoruba, Igbo, Somali, Zulu,
Xhosa, Malagasy and Kinyarwanda. Every pack covers the same canonical keys
and is shipped in Server, Tauri and Capacitor. These packs were drafted and
edited with AI from the public English catalog; cached machine translations
and existing closely related language packs were used where available. The
same structural checks and native-speaker review limitations apply.

The screenshot, diagnostics, cloud-settings and remote-input controls are covered
by all 88 dictionaries. Translation drafts for public UI text were checked for
formatting, literal commands, context and remaining English prose, with separate
agent review. Automated checks and AI review do not certify native-speaker
fluency. The scanner extracts screenshot status assignments and `failGrant`
messages, and audits the settings page's `view.message` boundary separately.

Kurdish uses Kurmanji Latin, Sindhi uses Arabic, Tajik/Kyrgyz/Mongolian use
Cyrillic, and Turkmen uses Latin. These choices do not represent other scripts
or language varieties. CLDR main exemplars plus documented auxiliary characters
cover their modern alphabets. Somali includes its auxiliary vowels; Kyrgyz adds
the auxiliary loan letters. Hausa, Yoruba and Igbo provide tone marks; Malagasy
includes auxiliary accented letters. Both composed and decomposed spellings are
enterable where needed for channel search. Odia and Assamese include
direct encoded nukta letters as well as combining sequences. Sindhi offers both
its CLDR default Arabic-Indic digits and the extended Persian digit forms.

Amharic supplies all 282 main-exemplar Ethiopic syllables on paged keys, with
script punctuation and numerals. This is a literal syllabary, not a phonetic
transliterator. Lao includes native digits and an explicit `ZWSP` key for its
zero-width word separator. The label is visible, but only U+200B enters the
value. Combining signs still display a dotted circle without inserting it.
Georgian uppercase input uses an explicit modern Mtavruli mapping for TV engines
whose Unicode casing tables predate Unicode 11; visible glyphs still depend on
the device's fonts.

## Search, cursor movement and bidirectional text

Channel, programme, history and media-library search use canonical Unicode normalization with
Turkish/Azerbaijani case rules tied to the selected interface language. The common
remote/API caseless helper preserves its locale-independent case-fold contract.
Remote `channel_by_name` selection follows the interface search rules, and media
filtering applies the same comparison to both visible results and shuffle queues.
The media filter retains its existing Russian `ё`/`е` equivalence and whitespace
normalization.
All 1,585 default Unicode 17 C/F mappings are generated from the repository's
pinned reference, so search casing no longer depends on the device's tables.
Turkish/Azerbaijani tailoring is separate from default folding.
Normalization operates on comparison keys only: names, URLs and saved input retain
their original bytes. Accents remain significant; this is not transliteration or
accent stripping. Compact pinned Unicode 17 tables supply canonical composition,
decomposition and combining classes on every engine, including devices whose
native normalization API uses older Unicode data. Hangul normalization is
algorithmic. Regenerate them offline with
`python3.14 scripts/generate-localization-unicode.py` (Python 3.14 supplies the
pinned `unicodedata` 16.0.0 base); source hashes and the Unicode 17
combining-class additions are checked against the pinned inputs.

The keyboard moves and deletes at grapheme boundaries. All engines use pinned
Unicode 17 grapheme-break, extended-pictographic and Indic-conjunct properties
with matching conformance vectors. It handles surrogate pairs, combining marks,
Indic sequences, emoji modifiers, ZWJ sequences and regional-indicator pairs
without consuming a following space or unrelated letter. It does not split an
emoji into invalid UTF-16 halves. Device IMEs still own native composition.

Arabic/Hebrew-script text containers use RTL direction while remote navigation and
player geometry retain their established order. Explicit URLs and numeric IDs are
isolated LTR; direction markers are never inserted into saved input. Dates and
numbers use the selected locale when `Intl` is available and retain usable legacy
formatting otherwise. Bookmark age uses a neutral “Bookmark age (days): %1” label
so a single English plural rule is not imposed on other languages.

## Bundle cost and verification

At `6fa14dc7`, on Node 22.23.3 with version 1.1.53, the complete localization change increases
the web entry from 746,380 bytes (228,703 gzip) at `8c240190` to 783,615 bytes
(243,951 gzip). An independent intermediate build attributes 23,186 raw bytes
and 10,982 gzip bytes to pinned Unicode support; the remaining interface,
startup, storage recovery and media-language behavior adds 14,049 raw bytes and 4,266 gzip bytes.
The dictionaries remain external assets. All Unicode tables count inside the
entry; all seven optional provider families count toward the complete payload.

That native entry is 783,573 bytes (244,023 gzip). Including every provider,
the web/native totals are 888,391/888,349 raw bytes and 283,217/283,289 gzip bytes.
The size limits remain unchanged after the bounded-cookie fix. At this version,
the smaller web/native reserves are 685 raw / 477 gzip bytes for the entry and
2,009 raw / 411 gzip bytes for the complete payload. Measure the current checkout with `npm ci`, `npm run build` and
`npm run check:size` on Node 22; `npm run check:bundle` also runs the pinned
normalization/grapheme tests against the optimized entry. Long nonstarter runs
use stable combining-class buckets to avoid quadratic reordering; conformance
tests cover leading marks, equal-class stability and starter boundaries.

## Unicode attribution

Alphabet coverage data is derived from Unicode CLDR 48. Canonical normalization
and character-class data are derived from Unicode 17.0.0.
Copyright © 1991–2025 Unicode, Inc. The upstream license also carries
Copyright © 2004–2025 Unicode, Inc. The complete, unchanged
[Unicode License V3](../js/licenses/Unicode-3.0.txt) accompanies the fixture and
alphabet data. SPDX identifier: `Unicode-3.0`.

The upstream data remains under its own license; the project's MIT license does
not replace that notice. Unicode provides character data, not an endorsement of
OTTplay FOSS or a review of its translations.
