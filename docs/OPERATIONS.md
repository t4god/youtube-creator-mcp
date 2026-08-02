# Production operations

This MCP is a local account-management process, not a hosted multi-tenant service. Run one
instance per operating-system account and Google Cloud project. Do not expose its stdio process,
application-data directory, or OAuth callback port to untrusted users.

## Safe rollout

1. Pin a tagged release or an exact commit and install with `npm ci`.
2. Run `npm run validate` before connecting the server.
3. Authorize with the smallest OAuth profile that covers the intended work.
4. Start with all write gates disabled and verify read-only channel/analytics tools.
5. Configure only narrow absolute media roots.
6. Enable a write gate only for the reviewed action, then restart the MCP client and disable it afterward.

## Publishing procedure

1. Call `youtube_upload_plan` with the final file and metadata.
2. Review the SHA-256, byte count, visibility, schedule, audience declaration, synthetic-media
   declaration, notifications setting, and required confirmation.
3. For private uploads, enable writes and pass `APPLY`. For public, unlisted, or scheduled
   uploads, also enable publication and pass `PUBLISH`.
4. Keep the same operation ID if a completed call response is accidentally resubmitted.
5. If an upload is marked in-progress or failed, inspect YouTube Studio before trying anything
   else. Use a new operation ID only after confirming no video was created.
6. Check `youtube_upload_status` and the Studio UI before announcing publication.

## Backup and restore

The application-data directory contains SQLite snapshots, research cache, quota history, write
audit records, upload operation state, exports, and—on Linux/Windows or explicit file mode—OAuth
credentials. Stop the MCP before copying this directory. Protect backups as secrets.

On macOS, OAuth credentials normally remain in Keychain and require a separate encrypted system
backup. Restoring only SQLite does not restore Keychain items.

## Credential rotation

- Run `youtube-mcp logout` to remove locally stored OAuth credentials.
- Revoke the application's access in the Google account when a machine or credential may be compromised.
- Replace the desktop OAuth client in Google Cloud if its client secret was disclosed.
- Re-run authorization and verify `youtube_auth_status` without logging tokens.

## Incident response

1. Disable all three write gates and stop the MCP process.
2. Review `youtube_write_audit`, YouTube Studio activity, and Google Cloud API metrics.
3. Revoke OAuth access if unauthorized channel access is possible.
4. Preserve the SQLite database and application logs without publishing private channel data.
5. Report authorization bypasses, credential exposure, arbitrary file access, or unintended
   writes through GitHub private vulnerability reporting.

## Monitoring

- Treat `youtube_quota_status` as a local estimate only; alert from Google Cloud for authoritative usage.
- Watch repeated 429/5xx errors, unexpected write-audit entries, and upload operations left in-progress.
- Update deliberately, rerun validation, and reauthorize only when new scopes are actually required.
