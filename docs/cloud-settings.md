# Cloud settings transfers

The retained `cloudSendSettings` and `cloudLoadSettings` device API now delegates
to a single transfer owner. It captures its source selection, storage ports and
about screen; superseding, closing or expiring that owner cancels its request and
poll timer. Late success/error callbacks and callbacks from an aborted operation
cannot write storage or replace another screen. A newer operation created inside
cleanup wins. Transfer codes remain visible until that screen closes.

The firmware service contract remains POST `/swop/a.php`: `send` with `d`,
`get_code`, and `get` with the returned code. Requests time out after 10 seconds;
the first poll waits 10 seconds, retries wait 5 seconds, and the transfer expires
after 10 minutes. Native save still opens local JSON export; Play menu policy
is unchanged. This implementation does not require DOMParser, fetch,
AbortController, TextEncoder or Promise.

## Storage document codec

Cloud backups contain raw full-device storage, including provider and playlist
namespaces, compressed values, canonical library documents and rollback keys.
They are separate from portable settings JSON v2. Installation credentials,
remote-control authority, local listener consent and recursive local backup
snapshots are excluded through the existing shared-core policy.

New documents carry the `<!--ottplay-storage-v2-->` marker. Keys and values are
JSON strings with XML escaping; control characters and surrogate code units are
encoded explicitly, including on older JSON implementations. This preserves
arbitrary raw UTF-16 without invalid XML characters or entity expansion. Readers
from before this format change cannot decode the new representation.

Unmarked historical documents remain readable. Their literal entities and raw
compressed strings retain their original bytes. Ambiguous structural delimiters,
truncation, duplicates, unsafe object keys, unsupported framing and malformed
versioned values reject the complete document before any storage mutation. The
fixed historical DOCTYPE is recognized as framing only; no DTD is fetched.

## Restore boundary

Restore validates the whole document, captures the current raw storage map and
prepares writes and removals. It never calls `stbClearAllItems`. The same guarded
batch used by settings drafts checks every original value before mutation and
reads back every result. On failure it attempts to roll back only the attempted
prefix whose bytes still belong to that operation. Concurrent external values
are preserved, and no success or restart is published on a failed batch.

Some provider identities read their credentials directly from storage. Replacing
those bytes is an intended effect of restoring an account. During the synchronous
batch, admission therefore follows the captured driver, provider/playlist
selection, storage ports, screen and transfer intent; outside that batch it also
checks the full account fingerprint. A user source switch or replacement driver
retires the operation. After commit, each runtime effect checks ownership again
before disconnecting command delivery, suspending old playback persistence,
invalidating guide requests and restarting.

Underlying legacy storage has no crash-safe transaction. Rollback can itself
fail, and a source replacement can leave the already attempted prefix written.
The operation reports failure and does not claim atomicity beyond the adapter.
Cloud restore keeps its historical installation policy: it does not import or
retain listener consent and transfer credentials. Local snapshot restore retains
its separate same-installation policy.

Tests use the real source and optimized Full/Play artifacts with controlled
network/storage ports. They cover legacy XML, all UTF-16 code units, partial
writes/deletes, storage-backed account changes, UI reentry and late callbacks.
The remote firmware service and physical TV/STB firmware require a separate
integration pass; these tests do not establish their compatibility.
