# Maintenance roadmap

Priorities for October 2026 through October 2027:

- Keep browser/STB playback, provider adapters, guide parsing and native media
  sessions consistent while preserving cancellation and source isolation.
- Maintain the Rust server, mobile wrappers and shared-core boundary with
  explicit authentication, bounded network parsing and redacted diagnostics.
- Resolve the recorded WebKit qualification failure and retain source-bound
  browser, native, actual-package and RC fuzz evidence before stable promotion.
  A successful host test does not qualify every TV firmware or paid provider.
- Complete cryptographic and dependency review across outbound connections,
  native platforms, third-party provider code and release tools. The Rust
  server's configured-certificate policy alone does not establish this.
- Keep immutable dependency provenance, third-party license notices and build
  instructions current; publish measurements with their scope and limitations.
- Establish a backup maintainer and tested repository/CI/release access recovery
  before claiming continuity. Neither currently exists.

These priorities do not guarantee release dates. Provider subscriptions,
third-party service availability, unsupported TV firmware and app-store approval
are outside the project's control.
