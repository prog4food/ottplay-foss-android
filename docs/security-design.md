# Security design and verification

## Scope and trust boundaries

The project provides the browser/STB player, native wrappers and local media/control companions.

Provider URLs, playlists, XMLTV data, artwork, subtitles and remote commands cross trust boundaries. Credentials can be embedded in URLs and headers; redact diagnostics and exports before sharing. Keep backend authentication independent of browser origin checks, validate redirects, and preserve bounds and cancellation for network parsing. Browser parental controls do not authenticate an operating-system owner.

## Source and operating documentation

- [docs/architecture.md](../docs/architecture.md)
- [docs/diagnostic-security.md](../docs/diagnostic-security.md)
- [docs/playback-session-architecture.md](../docs/playback-session-architecture.md)

## Regression evidence

- [tests](../tests)

Run the documented commands in [CONTRIBUTING.md](../CONTRIBUTING.md) and the
[CI workflow](../.github/workflows/ci.yml). Preserve negative tests for rejected inputs,
unavailable dependencies, authorization failures and cancellation. A passing
test run describes its fixtures and environment; it does not certify every
upstream service, hardware model or production deployment.

## Rust server certificate configuration

Before opening either listener, the Rust server checks every certificate in its
supplied PEM chain. RSA and RSA-PSS public keys must have a modulus of at least
2048 bits. Supported EC named curves are P-224, P-256, secp256k1, P-384 and P-521;
Ed25519 keys must contain 32 bytes. Unknown algorithms, unsupported curves,
malformed algorithm parameters and invalid DER encodings reject startup with the
certificate's position in the chain. Strict typed RustCrypto X.509 and PKCS#1
decoders perform the DER parsing. This minimum-strength policy does not add
support for private-key types that the TLS backend cannot load.

The check covers the leaf, intermediates and any root explicitly included in the
configured chain. It cannot inspect an omitted root in a client's trust store.
Clients remain responsible for normal trust-chain, signature, validity and
hostname verification. This server configuration check does not establish the
policy of outbound connections, browser/native platform transports or external
reverse proxies.

Keep the existing certificate PEM and PKCS#8 key formats. Replace an undersized
certificate or unsupported key before upgrading; removing a weak intermediate
from the file does not repair its chain. The
[binary startup tests](../src-rs/server/tests/tls_chain_policy.rs) generate local
synthetic chains and verify rejection before listening, as well as successful
verified HTTPS for supported strong RSA, EC and Ed25519 configurations. They also
retain P-224 and RSA-PSS intermediate compatibility.

## Static-analysis scope

The [CodeQL workflow](../.github/workflows/codeql.yml) analyzes JavaScript/TypeScript,
Python tooling, GitHub Actions and Rust source. Swift extraction uses the actual
unsigned iOS App build on macOS. A successful run covers the extracted code and
enabled queries; it does not establish that every vulnerability is absent.

The [Capacitor Android project](../android/README.md) is compiled and audited in
native CI; this is not claimed as Kotlin CodeQL coverage. The separate
Android application and shared Kotlin core have separate analyses in
[ottplay-android](https://github.com/open-ott-play/ottplay-android) and
[ottplay-core](https://github.com/open-ott-play/ottplay-core). The Objective-C drag
regression fixture is exercised by its native test; CodeQL does not support that
language. The existing [CodeQL configuration](../.github/codeql/codeql-config.yml)
excludes third-party provider scripts, so provider behavior still needs its own
review and integration tests.

## Remaining security assessment

Complete language-by-language cryptography and dynamic memory-safety review, assess tracked vendor binaries with provenance, and verify release notes/security history before asserting full Passing.

Report new issues through [SECURITY.md](../SECURITY.md). An OpenSSF assessment
records evidence and applicability; it is not a guarantee that a system is safe.

## Parental PIN persistence

See [versioned PIN storage and migration](parental-pin-storage.md) for the actual
KDF, legacy transition, backup compatibility and downgrade limitations.
