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

Deletion, abuse reporting, and other destructive operations additionally require
`YOUTUBE_MCP_ENABLE_DESTRUCTIVE=true` and `confirm="DELETE"`.

Keep both flags disabled unless you are intentionally performing a reviewed operation.
