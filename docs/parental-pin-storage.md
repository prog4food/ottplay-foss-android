# Parental PIN storage and migration

New or changed four-digit PINs are stored as one versioned
`pbkdf2-sha256$600000$<salt>$<digest>` record in the existing `parentPIN` setting.
The salt contains 128 random bits from the platform CSPRNG and the derived value
is 256 bits. PBKDF2-HMAC-SHA256 uses 600,000 iterations. The four-digit interface
is unchanged; its small search space means this is a local parental-control
barrier, not protection against an administrator or an attacker controlling the
player code, files or device. Keep device accounts and backups private.

Web Crypto performs ordinary derivation. The ES5 fallback uses the pinned SJCL
1.0.9 SHA256/HMAC primitives, scheduling the same single-block PBKDF2 loop in
bounded chunks so input events can continue. The chunk scheduler and PBKDF2 loop
are project-maintained adaptations, not an unchanged asynchronous SJCL API;
matching test vectors do not replace independent cryptographic review. Only one asynchronous derivation
runs at a time. Neither implementation uses `Math.random`, clock values or the
SJCL pseudorandom generator for salts. New PIN creation fails if the platform
has no working `crypto.getRandomValues` or `msCrypto.getRandomValues`.

At settings load, the current player revokes prior parental grants and converts
an existing readable four-digit PIN to the protected format before publishing a
usable credential. It also protects the historical `1234` first-install default,
but only when storage actually reports absence. The write must be read back
exactly with the same source, storage functions and settings revision. Failed
randomness, reads, writes or reentrant/source-changing callbacks leave the current
player locked; a failed migration can leave legacy bytes on disk but cannot
permit current-player access. A later successful load can retry. Already
protected records and the explicit disabled marker `*` do not run another KDF.
Malformed or unreadable storage never becomes the first-install default.

This one-time load uses synchronous SJCL PBKDF2 with the word-array copy patch
described below.
The existing startup screen is displayed before the asynchronous application
bundle loads, but input/animation may pause during derivation. Five local Node
26/Apple-silicon conversions took 946–966 ms; 1,000 already-protected values took
about 0.3 ms in total. Older TVs may take substantially longer and have not been
performance-qualified. This change does not rewrite inactive historical
installations or permit downgrading upgraded storage.
Settings saves and old JSON/XML/local-backup imports convert plaintext values
before writing. A transaction that changes a legacy PIN also prepares a protected
rollback value before its first write, so later failure cannot write plaintext
back to storage. Exports convert legacy PINs and preserve existing versioned
records exactly. The existing synchronous backup APIs use the same full work
factor synchronously for a legacy value: conversion pauses the interface until
derivation completes and can take substantially longer on an older TV. Preparing
legacy rollback bytes currently has the same synchronous cost, including before
a settings transaction. Cancel before confirmation to avoid changing settings. Invalid records and
unreadable PIN storage lock protection instead of silently selecting `1234`.
Recovery requires restoring a valid private backup or explicitly resetting the
installation; the player does not guess or recover a damaged PIN.

Close other player tabs before upgrading. Do not run an older version against
upgraded settings: older versions do not understand these records and some
restore their historical default `1234` when parsing fails. The new release
cannot correct already-running or downgraded code. Backups containing the new
record likewise require this version or later.

The native and fallback tests compare results with Node's independent PBKDF2
and the pinned upstream SJCL PBKDF2, exercise wrong PINs, malformed/high-work records,
missing randomness, cancellation and real settings-store write failures. Local
Apple-silicon Node measurements are host evidence, not TV/device acceptance:
a sample creation took about 53 ms with Web Crypto and 1.6 s with the chunked
fallback. Target-device performance remains to be measured. No physical device
was modified by these tests.

Local backup restore verifies the protected PIN before replacing other keys and
never clears that credential between writes. A rejected PIN write aborts the
restore; a later ordinary-setting failure retains the protected PIN. This is not
a cross-key transaction guarantee for every preference.

The selected SJCL source has a narrowly scoped word-array copy patch. On V8,
core-js compatibility probes for legacy/non-Chromium user-agent strings can
deoptimize native Array species operations. The original synchronous derivation
then took about 17.5 seconds in a local Chromium legacy-UA measurement, versus
about 0.8 seconds after replacing numeric word copy/concatenation/front-removal with
indexed word copies. These are host measurements, not physical-TV qualification.
SHA256 rounds, HMAC, PBKDF2 iteration counts, partial-word values and buffer
ownership are unchanged. The helpers operate on internal numeric word arrays;
they intentionally do not dispatch custom Array species/subclasses. General
bit slicing and negative/NaN clamp copying retain the upstream implementation.
Nonnegative clamp copying also uses the helper: the salt produced by the native
Array slice otherwise carries the V8 deoptimization into the entire derivation.
Partial-word masking, oversized-input identity and numeric boundary semantics
remain unchanged.

`js/vendor/sjcl-pin-source.json` records the upstream files, original bundle hash,
patched bundle hash and exact reversible patch. Differential tests reconstruct
the original bundle, cover partial words, streaming hash state, both typed-array
paths, HMAC and PBKDF2, and compare the full 600,000-iteration result with Node's
independent cryptographic implementation. The required device browser matrix
continues to use the original UA fixtures and existing timeouts.
