# Interface credits and design history

**Studio 2026** is the default presentation, designed for the OTT-play FOSS
project in September 2026. It uses neutral graphite surfaces, mint accents and
a continuous light focus row. It retains the established two-panel navigation
and user-controlled list density. This is an original presentation of the
existing player, not an upstream OpenPLi skin. See [settings and validation](interface-settings.md).

OTT-play FOSS's selectable **PLi-HD** theme is a web implementation of the visual language
of the PLi-HD skin for Enigma2 receivers. Credit for that design belongs to its
original authors. This project is independently maintained and does not imply
endorsement by OpenPLi, Vali, littlesat or other upstream contributors.

## Authors and sources

- **Vali** created **Magic_HD_Shadow_MiniTV**, credited with the dates **2009–2010**
  in the PLi-HD source. Those are attribution dates, not a verified first-release date.
- **littlesat and the PLi-HD contributors** maintain
  [skin-PLiHD](https://github.com/littlesat/skin-PLiHD).
  Its source explicitly also credits derived work from **VU+NL, Milo and others**.
- **alex_qr**, author of the original OTT-play, described its interface as similar
  to OpenPLi in his [Enigma2 forum post](https://gomel-sat.bz/topic/40996-ott-play-%D0%BF%D0%BB%D0%B5%D0%B5%D1%80-%D0%BD%D0%B0-enigma2/).
- **prog4food**, maintainer of the earlier OTT-play FOSS project, linked to
  [OpenPLi Wiki: Problems and Solutions](https://wiki.openpli.org/Problems_and_Solutions)
  as a visual reference in the [FOSS project description](https://ottp.eu.org/www/foss/#_3).
  See also the [inherited component notices](legacy-provenance.md).

## History

1. **2009–2010:** dates attached to Vali's Magic_HD_Shadow_MiniTV attribution.
2. **17 November 2011:** the [initial substantive PLi-HD import](https://github.com/littlesat/skin-PLiHD/commit/d900f5f49bfda99c6682f905a11da452de37ffc5)
   already contains the earlier-design credits, dark palette, gold accents,
   small video preview and adjacent selection list.
3. **11 March 2019 / 13 July 2020:** alex_qr's forum post was created in 2019
   and subsequently edited in 2020. The currently available text describes
   OTT-play's similarity to OpenPLi; it does not establish when that sentence
   first appeared. It names Vu+ Ultimo and Vu+ Zero as tested receivers.
4. **2026:** this project introduced a selectable PLi-HD palette and then adapted
   the panel geometry from the upstream XML. The Classic theme remains available.

OpenPLi is a receiver software distribution; Enigma2 supplies its user interface;
PLi-HD is a skin for that interface. The evidence identifies a software-design
lineage, not one exclusive hardware model or an established transfer of Enigma2
engine code into OTT-play.

## Reference used for this adaptation

The reference is PLi-HD at commit
[`3db10e14a07a885b0ea53cb7142bc5265f1da725`](https://github.com/littlesat/skin-PLiHD/tree/3db10e14a07a885b0ea53cb7142bc5265f1da725).

- [skin.xml](https://github.com/littlesat/skin-PLiHD/blob/3db10e14a07a885b0ea53cb7142bc5265f1da725/usr/share/enigma2/PLi-HD/skin.xml)
  provides the authorship notice and colour definitions.
- [skin_templates.xml](https://github.com/littlesat/skin-PLiHD/blob/3db10e14a07a885b0ea53cb7142bc5265f1da725/usr/share/enigma2/PLi-HD/skin_templates.xml)
  provides TopTemplate, SelectionTemplate and ChannelSelectionTemplate geometry.

On the upstream 1280 × 720 canvas, the preview starts at (85, 110) and measures
417 × 243; the channel list starts at (530, 110) and measures 690 × 510.
The adaptation scales those relationships with the viewport and mirrors them for
the left-list setting. Video retains the player's configured aspect handling.
List density, fonts, remote actions and playback remain OTT-play settings.

This implementation uses its own HTML/CSS and existing player components. It
does not bundle upstream skin bitmaps, logos, fonts or Enigma2 XML files.

## Upstream terms and attribution

The [upstream header](https://github.com/littlesat/skin-PLiHD/blob/3db10e14a07a885b0ea53cb7142bc5265f1da725/usr/share/enigma2/PLi-HD/skin.xml#L3-L7)
describes the skin as freeware, permits modification and use in other images,
and requires preservation of its attribution without claiming the design as
one's own. These are the upstream author's own terms; this document does not
relicense that material under this repository's MIT license.

The player's information menu includes **Interface credits**, an English screen
with attribution and design history. Its text is bundled for offline
reading; external source links require a connection.
