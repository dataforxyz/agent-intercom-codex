# Changelog

## [0.1.0] - 2026-07-03

### Added
- Added Codex MCP stdio server for local intercom messaging.
- Added tools for identity, status, session listing, summary updates, send,
  ask, pending, and reply.
- Added Codex plugin metadata and a `codex-intercom` skill.
- Vendored the minimal pi-intercom broker/client protocol for compatibility.
- Added an app-server bridge daemon that publishes virtual Codex workers as
  intercom sessions and wakes app-server turns on inbound messages.
- Added bridge config/state helpers and a `npm run codex:bridge` script.

### Fixed
- Shut down the MCP server when stdio closes so completed Codex runs do not
  leave stale intercom sessions behind.
- Defaulted bridge app-server launch to direct `codex app-server` mode so it
  works without the standalone managed daemon install.

### Docs
- Documented Codex MCP environment-variable behavior and the recommended
  `intercom_set_summary` discovery flow for ad hoc multi-Codex runs.
- Documented bridge configuration, security defaults, and managed daemon proxy
  mode.
