# Pinned Unicode search and editor references

The player uses **Unicode 17.0.0** for canonical normalization, extended
grapheme boundaries and full default `C` + `F` case folding. Its ES5 implementation
uses compact generated tables instead of relying on the TV engine's Unicode
version. Display text, credentials and provider/channel identifiers are unchanged;
only comparison keys and editor cursor boundaries use these routines.

Search preserves accents and compatibility distinctions: `cafe` and `café` differ.
Canonical equivalents match. Default folding preserves dotless `ı`; Turkish and
Azeri add the Unicode `Before_Dot` tailoring, including intervening marks.
Search keys apply NFD before case folding and NFC afterwards. This preserves
canonical caseless equivalence when folding introduces a starter or exposes a
new composition, while keeping accent-sensitive substrings intact. Tests cover
contextual folds, key idempotence and actual channel/history filtering.
Case-fold expansions remain searchable. Normalization and grapheme behavior stay
pinned even if older native `normalize` or `Intl.Segmenter` APIs are present.

All reference data uses [Unicode License V3](../../../js/licenses/Unicode-3.0.txt),
SPDX `Unicode-3.0`.

## Case folding

`CaseFolding-17.0.0.txt` is the unchanged reference downloaded on 2026-09-29 from
<https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt>. SHA-256:
`ff8d8fefbf123574205085d6714c36149eb946d717a0c585c27f0f4ef58c4183`.
The generator includes all 1,585 `C`/`F` mappings in the compact runtime table;
the original text fixture is not shipped. The remote-search test checks every
code point against this reference with native normalization and casing disabled.

## Normalization

[`unicode-normalization-17.json`](../unicode-normalization-17.json) contains all
20,034 official Unicode 17 normalization vectors as gzip/base64-encoded UTF-8 JSON.
Its source URLs, original-file SHA-256 hashes and decoded-payload hash are pinned.
Excluding its 69 added indexes reproduces the exact ordered 19,965-vector Unicode
16 set, verified by a separate payload hash. This fixture is test-only.
`test_localization_unicode.cjs` checks NFC and NFD for all five columns in both
versions: 200,340 and 199,650 assertions respectively. The offline
`scripts/generate-localization-normalization-fixture.py` recreates the fixture from
two local official files, validating their source hashes first. NFKC/NFKD columns provide
canonical-normalization inputs; the player does not apply compatibility folding.

The offline runtime generator requires Python 3.14's Unicode 16 database and the
source-hashed Unicode 17 overlay in `scripts/localization-unicode-normalization.json`.
The 2,081 canonical decompositions and 961 compositions are unchanged; their hashes
are checked. All 34 added combining classes are applied, giving 968 nonzero classes.
`--verify-normalization` additionally downloads the pinned Unicode 17 sources and
verifies every decomposition, composition and combining class.
`--check-inputs` validates the offline metadata without requiring that host
database or writing output. The portable generator tests reject malformed or
overlapping ranges and invalid combining classes before generated data changes.

## Grapheme boundaries

[`unicode-grapheme-break-17.json`](../unicode-grapheme-break-17.json) pins all 766
Unicode 17 vectors. The 1,093-vector [Unicode 16 fixture](../unicode-grapheme-break-16.json)
is also retained. Exactly one older expectation changes: Unicode 17 removes U+2701
from `Extended_Pictographic`, so `U+2701 ZWJ U+2701` has UTF-16 boundaries `[0,2,3]`
instead of `[0,3]`. The new fixture explicitly records this normative difference.

The offline generator uses the source-hashed GCB, Extended_Pictographic and InCB
ranges in `scripts/localization-unicode-graphemes.json`; Hangul is algorithmic.
`--verify-graphemes` downloads all three pinned sources and checks their hashes and
exact extracted ranges. The editor tests also exercise actual Delete and cursor
movement, including virama followed by whitespace, punctuation, Latin text or ZWJ.
