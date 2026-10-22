# Collection performance checks

The October 2026 collection changes preserve the existing ES5 runtime, stored
documents, ordering, reference identity and source-ownership checks. They target
work that grows with the number of channels or favorites:

- Channel lock reconciliation uses a temporary null-prototype membership index.
  Stored and migrated IDs keep their original order; explicit unlocks still win.
  The index is local to reconciliation and cannot become stale across mutations.
  Exclusion sets live inside the deduplication call; the legacy migration index
  is explicitly released because returned methods share its closure. This must
  also hold after minification, which can inline an apparently isolated function.
- Favorite merging appends invisible references to their retained neighbor's
  bucket, then appends those buckets to the result. It does not repeatedly copy
  the growing prefix. Equal reference values do not replace object identity.
  The snapshot caller also tells record construction that these exact merged
  references already contain every selected prior binding. Other callers retain
  the identity-membership check; no semantic-key approximation is used.
- Diagnostic reads derive their first array position from the cursor and oldest
  retained sequence. Accepted sequence IDs are consecutive; rejection allocates
  no ID and eviction removes only a prefix. Clearing retains the sequence counter.

## Reproducing the measurements

Use the same Node version and dependencies for both source trees. The comparison
base is `25b0881541c7a9c54e312354592e788218da71d0`. With that revision checked out
separately, run from the candidate:

```sh
node scripts/measure-channel-collections.cjs --base-root /path/to/baseline --out /tmp/channel-measurements.json
npm run build
npm run check:size
npm run check:bundle
```

The benchmark compiles the actual functions to ES5, checks equal output and
reference identity, alternates warmed baseline/candidate samples, and counts
array scans/copies separately from timings. It includes the favorite-record
construction after merging, so an isolated helper improvement cannot hide the
cost of preparing the resulting record. Synthetic Node timings are not physical
TV measurements or whole-player speedups.

Build both revisions and compare `build/reports/classic-bundle.json`, including
the web and native entries and **all** optional provider bundles. Standalone
helper size is insufficient; the existing complete-payload budgets remain in
force. No timing threshold is used in CI. Regression tests check behavior and
bound avoidable array work deterministically.
