# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added

- Typed tools to post, reply to, edit, moderate, and delete YouTube comments with the
  existing write audit and confirmation guardrails.
- A documented persistent creator-mode configuration for trusted personal MCP installs.

## 0.2.0 - 2026-08-02

### Added

- Typed upload planning, private-by-default video upload, metadata/status updates,
  thumbnail upload, upload processing status, and local write-audit tools.
- An independent publication gate and `PUBLISH` confirmation for public, unlisted,
  scheduled, and live publication actions.
- Content-and-metadata upload fingerprints with operation IDs to block accidental duplicates.
- Timeouts and bounded exponential retries for idempotent reads; writes are not blindly retried.
- SQLite schema versioning, busy-timeout handling, write audit records, and upload operation state.
- Production operations guide and expanded MCP integration/safety coverage.

### Fixed

- Corrected `search.list` and `videos.insert` quota estimates to 100 units and reported
  all Data API operations against one shared project quota pool.
- Removed the internal Google client context object from capability discovery.

## 0.1.0 - 2026-08-02

### Added

- Official YouTube Data, Analytics, Reporting, and Live Streaming API access.
- High-level channel, analytics, research, topic-comparison, and comment tools.
- Local competitor snapshots with longitudinal view, like, and comment deltas.
- Guarded uploads, metadata management, moderation, captions, and live operations.
- macOS Keychain credential storage and private file fallback for Linux and Windows.
- Local quota ledger, research cache, structured MCP errors, and release validation.
