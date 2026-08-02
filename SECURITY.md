# Security policy

## Supported versions

Security fixes are applied to the latest release on the default branch.

## Reporting a vulnerability

Do not open a public issue for a vulnerability involving credential exposure,
authorization bypass, arbitrary file access, or unintended YouTube writes.
Use GitHub's private vulnerability reporting for this repository instead.
Include the affected version, reproduction steps, impact, and any suggested
mitigation. Please do not access accounts or data that you do not own.

## Credential model

- Every installation must use credentials from its own Google Cloud project.
- OAuth client JSON files, access tokens, and refresh tokens must never be committed.
- macOS uses Keychain by default.
- Linux and Windows use a per-user file with restrictive permissions by default.
- Set `YOUTUBE_MCP_SECRET_STORE=file` only when local file storage matches your threat model.
- The local SQLite database stores quota events, public snapshots, and research cache entries, never OAuth credentials.

## Write safety

External writes require all applicable controls:

1. An OAuth profile with write scopes.
2. `YOUTUBE_MCP_ENABLE_WRITES=true` in the server environment.
3. `confirm="APPLY"` in the tool call.

Publishing, unlisting, scheduling, and live-broadcast publication additionally require
`YOUTUBE_MCP_ENABLE_PUBLICATION=true` and `confirm="PUBLISH"`. This gate is separate so
metadata management does not silently grant publication authority.

Deletion, abuse reporting, and other destructive operations additionally require
`YOUTUBE_MCP_ENABLE_DESTRUCTIVE=true` and `confirm="DELETE"`.

Keep both flags disabled unless you are intentionally performing a reviewed operation.

Typed uploads require a caller-supplied operation ID and record a content-and-metadata
fingerprint. Completed operations return the prior result instead of uploading again.
In-progress or failed operations are not automatically retried: first verify YouTube Studio,
because a network or process failure can happen after YouTube accepted the media but before
the local database recorded success.

Write audit records contain operation names, targets, outcomes, and normalized errors. They
do not contain OAuth credentials or media content. They are stored in the local SQLite file
and should still be protected as channel-management metadata.
