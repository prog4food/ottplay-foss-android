# Channel catalog and user state

`ChannelLibrary` owns a versioned, source-scoped document for user groups,
parental locks, selection and playback preferences. The provider catalog is a
separate input. `cats`, `catsArray` and numeric list positions are projections
created by `classic-library.ts` for the retained renderer and device ABI.

Commands use group and item IDs. Renaming a provider group preserves its live
membership; explicit membership edits preserve removals and include newly
discovered channels. A copied group is independent. Missing channels retain
their user data so it becomes available if they return.

The merged core catalog API supplies Xtream and Stalker item/category IDs.
`channel-catalog.ts` projects these references to numeric adapter IDs and
rejects collisions. Old title hashes only feed the migration observer;
ambiguous and cyclic migration mappings are not guessed. Protocols without
an upstream identity still require a URL or label fallback.

The source namespace separates provider accounts and M3U slots. Favorites
reuse the existing core list model in a source-scoped envelope. Channel
history uses the same namespace and stable group references. Existing
storage is imported once, with a claim preventing another account from
inheriting the same old records. Old keys remain available for recovery.
Unknown document versions and failed reads prevent writes. Failed writes do
not publish a new in-memory channel document.

Production JavaScript retains ES5. The unused `devices/legacy-core.js` artifact is excluded
from browser and native staging but retained as a test fixture.
The packaging audit rejects its reappearance in the shipped roots.
