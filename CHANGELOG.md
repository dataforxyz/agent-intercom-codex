# Changelog

## [0.1.0] - 2026-07-03

### Added
- Added Codex MCP stdio server for local intercom messaging.
- Added tools for identity, status, session listing, summary updates, send,
  ask, pending, and reply.
- Added Codex plugin metadata and a `codex-intercom` skill.
- Vendored the minimal pi-intercom broker/client protocol for compatibility.

### Fixed
- Shut down the MCP server when stdio closes so completed Codex runs do not
  leave stale intercom sessions behind.

### Docs
- Documented Codex MCP environment-variable behavior and the recommended
  `intercom_set_summary` discovery flow for ad hoc multi-Codex runs.
