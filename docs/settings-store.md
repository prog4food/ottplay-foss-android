# Settings ownership and editor lifecycle

`src/settings/store.ts` owns the current preferences. The schema in
`src/settings/index.ts` defines stable IDs, existing storage keys, application
or provider scope, validation, defaults and post-commit effects. `settings`
and the retained `window.s*` properties are ES5 accessors into that one store;
there is no apply/pull copy. Array reads return detached values. The legacy
`sNextCount` offset is a storage codec; `nextCount` is a derived view.

Each row editor binds a `settingId` to a private draft. Filtering, translating
or reordering rows does not change the saved key. Save validates and commits
the draft, then runs each declared effect once. Cancel has no storage or
runtime effects. Nested colour and PIN editors retain the enclosing draft.
The screen ownership port, when present, disposes the draft with its list.
Callbacks also check draft, source and row ownership before committing.
Command URL and command-server value dialogs use the same draft lifecycle;
the existing network controllers keep their explicit consent transitions.

Provider changes and reloads retire open drafts. A fresh draft hydrates the
current provider scope if catalog loading has not yet done so. Provider storage
ports capture the active driver's absolute key, including M3U playlist slots.
Application preferences survive provider-only hydration. A concurrent change
to a field being edited rejects that commit; unrelated changes are preserved.

Commit captures old values, verifies every write by reading it back, and only
then publishes the new runtime values. On failure it attempts to restore the
captured keys and reports failure without publishing effects. Legacy storage
does not provide transactions: rollback can itself fail, and persistence may
then be partially written until a subsequent reload. The implementation does
not claim stronger atomicity than the backing storage supplies.

Portable JSON export now emits version 2. Its `tv` field contains the source
identity and detached ChannelLibrary/FavoritesLibrary documents, retaining
custom groups, hidden or missing items, preferences, unlocks and all favorite
lists. Export fails on unreadable or unsupported owned state. Installation-only
credentials and local consent remain excluded. Raw cloud/storage snapshots
use the separately versioned [cloud codec](cloud-settings.md); local raw
snapshots retain their separate restore policy.

Import validates before opening confirmation and captures both source identity
(including the account or M3U slot) and storage accessors. A foreign v2 source
is rejected. Version-1 aliases remain accepted; numeric channel references are
resolved as old raw IDs, and known collisions remain explicitly unresolved.
V1 replaces the active favorite list and locks while preserving other lists,
groups and preferences. It writes canonical documents even when migration
claim markers already exist, without changing the old rollback arrays.

The same SettingsDraft commit writes and reads back the canonical documents
and settings before publishing runtime values. Concurrent library edits reject
the confirmation. On failure it attempts rollback only while the captured
source and accessors remain current, and does not overwrite later external
writes. A source replacement stops the operation; legacy storage cannot promise
cross-source or crash atomicity. Success retires the previous library owners,
disables remote command control, reloads settings and restarts the player.
Attribution and historical source fixtures remain unchanged.

Verification covers draft cancellation, malformed values, storage rejection,
scope changes, M3U slots, row reorder/filtering, colour and PIN callbacks,
timezone behavior, old backups and the existing settings UI parity suite.
The Full and Play player artifacts retain ES5 syntax and are exercised by the
bundle boot/device fixtures. These fixtures are not physical-device testing.
