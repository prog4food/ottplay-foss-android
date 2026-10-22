# Manual XMLTV binding and keyboard accessibility

[Русский](guide-binding-accessibility.ru.md) · [Guide architecture](guide-architecture.md)

## Fix a channel's guide without editing the playlist

Play the affected M3U channel, open **Information → EPG**, then edit the EPG source URL and the **XMLTV ID**. Enter the exact ID from the XMLTV file's `<channel id="…">`, not its display name. Choose **Set** to persist the binding and reload the playlist. **Automatic** removes this channel's override and reloads the original playlist mapping. Arrow movement alone never saves or resets a binding. Back leaves the stored binding unchanged.

This editor is available in the hosted browser deployment and native XMLTV shells (Tauri and Capacitor). It does not override provider-owned guides, explicit `=source` JSON endpoints or external companion servers. A plain legacy browser using a remote companion keeps its existing matching protocol. The first version accepts an exact ID; it does not download or display a searchable list of every XMLTV channel.

![A manual binding connects the playlist source and stable channel to one XMLTV feed and exact ID; otherwise normal matching remains active.](images/guide-binding.svg)

A binding stores the playlist source fingerprint, stable channel key, explicit feed URL and XMLTV ID. Renaming a display label or changing row order does not change a binding when the channel identity stays the same. Replacing the playlist URL/account changes the source namespace. For legacy M3U entries without `itemId`, the existing URL-derived channel ID is used; changing that URL changes its identity.

The selected channel keeps its display name and playback URL. Guide lookup uses one explicit feed and no name fallback, so a missing ID does not silently borrow another channel's programme. Automatic regional offsets inferred from a channel name do not apply to this exact binding; explicit playlist `tvg-shift` still applies. Set the correct regional XMLTV ID. If a custom HTTPS-hosted feed cannot be read because of CORS or mixed-content rules, the normal EPG diagnostics report that failure.

The local record is bounded to 500 bindings and 512 KiB per source; it is parsed once for a playlist load, not once per channel. Writes compare the prior value and read back the stored result before reloading. A late editor callback cannot save into a replacement source. This is a local preference, not cross-device synchronization. Feed URLs may contain credentials; avoid sharing storage exports publicly.

## Accessible classic controls

- The virtualized main list exposes a named listbox, selected option, full item count and absolute item position. Only the selected visible row is a Tab stop. Arrow navigation updates both the visual selection and semantic state; focus follows an already-focused list through page replacement.
- Standard information/confirmation dialogs, the editor and About panels expose modal roles and localized names. Tab and Shift+Tab cycle within the foreground modal. Closing a nested modal restores a still-visible parent control; stale scheduled opens cannot steal focus after dismissal.
- Information and confirmation messages describe their dialogs. Temporary notices use a polite status region.
- Existing translation catalogs supply all added labels. XMLTV and ID are protocol identifiers; channel names and feed hostnames remain source metadata.

The application keeps its remote-control routes and ES5 syntax. Semantic DOM checks do not constitute complete WCAG certification: device-specific focus, VoiceOver/TalkBack speech and TV browser behavior still require physical testing.

## Verification

Run:

```sh
node tests/test_classic_accessibility.cjs
node tests/test_guide_bindings.cjs
node tests/test_screen_ownership.cjs
node tests/test_guide_integration.cjs
node tests/test_m3u_provider_driver.cjs
node tests/test_localization_catalog.cjs
npm run typecheck
```

Also run the ordinary build/ES5/bundle-size checks on the integrated branch. Browser checks should cover a long list across page boundaries; a nested confirmation; source replacement while editing; a correct, missing and removed binding; and an EPG download failure. The native Android application's semantic track preferences are implemented in its separate repository and are independent of these classic controls.
