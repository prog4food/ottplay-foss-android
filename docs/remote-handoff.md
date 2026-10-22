# Explicit playback handoff

[Русский](remote-handoff.ru.md) · [Improvements](roadmap-delivery.md)

With updated player and control CLI, run `ott handoff SOURCE TARGET`.
The source continues playing. The target needs the same configured source/account
and a unique stable channel ID. Channel references are versioned local fingerprints, never raw provider item IDs.
Classic M3U rows use the exact stream URL only as local hash input. Independently
signed or rewritten URLs therefore fail to match safely. No fuzzy name matching,
credentials or playable URL are transferred. Version 1 supports live/archive for M3U, Xtream and Stalker;
VOD/series and continuous watch-history synchronization are not supported.

`playback_handoff_export` accepts empty parameters and returns `data.handoff`:

```json
{"version":1,"provider":"m3u","source_id":"opaque-source-id","item_id":"channel-v1:01234567.89abcdef","kind":"live"}
```

Archive references use `kind: "archive"` and integer `archive_start` (current
playback point as Unix seconds). `playback_handoff_import` accepts only
`{"handoff": ...}`. The target enforces catalogue identity, archive availability,
parental/kiosk policy and current ownership before dispatch. It resolves streams
through its own provider. An accepted import returns
`{"status":"ok","data":{"dispatched":true,"kind":"live"}}`.
Dispatch is not confirmation of decoded video or audible HDMI sound.

Rejections expose only an error code: `unsupported`, `invalid_request`,
`no_current_item`, `source_mismatch`, `item_unavailable`, `ambiguous_item`,
`policy_denied`, `busy`, `playback_failed` or `context_changed`. References are
bounded; the receiver rejects additional fields. Use scoped operator permissions
for export/import and protect the controller connection. Source identity is an
opaque matching key, not a transferable access credential.

Run `node tests/test_remote_handoff.cjs`. See the
[control guide](https://github.com/open-ott-play/ottplay-control-server/blob/main/docs/reliable-control.md)
for authentication, outcomes and command TTL behavior.
