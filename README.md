# YouTube Creator MCP

[![CI](https://github.com/t4god/youtube-creator-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/t4god/youtube-creator-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A local, privacy-first Model Context Protocol server for creators who need direct
access to the official YouTube Data, Analytics, Reporting, and Live Streaming APIs.

Use it with Codex, Claude Desktop, Cursor, or another MCP client to analyze your
channel, research public topics, build local competitor history, and perform carefully
gated channel operations.

> Status: `v0.2.0`. Read-only analytics and research are the recommended path.
> Creator writes are typed, audited, opt-in, and disabled by default.

## Why this exists

Most YouTube MCP servers focus on public search or transcripts. YouTube Creator MCP
focuses on the creator's own source-of-truth data and official management APIs:

- Private analytics: retention, search terms, traffic, geography, demographics, and devices
- YouTube Reporting API jobs and bulk CSV exports
- Public video, channel, playlist, comment, membership, category, and activity data
- YouTube Live Streaming resources, broadcasts, streams, and live chat
- Persistent competitor snapshots and true deltas between captures
- Topic sampling, age-normalized velocity proxies, and breakout indicators
- Guarded uploads, captions, thumbnails, metadata, playlists, comments, and moderation
- Local quota ledger and research cache

This project deliberately does **not** estimate keyword search volume or expose private
competitor analytics. Pair it with other research sources when those signals matter.

## Security model

- Every installation uses its own Google Cloud project and OAuth credentials.
- OAuth credentials are never placed in MCP configuration.
- macOS stores credentials in Keychain by default.
- Linux and Windows use private per-user files by default.
- Research cache and snapshots live in a local SQLite database.
- External writes require server configuration **and** per-call confirmation.
- Publication has its own independent server gate and `PUBLISH` confirmation.
- Destructive operations require a second independent server flag and stronger confirmation.
- Upload and download paths are restricted to explicit media roots with symlink containment checks.
- Upload operation IDs and fingerprints block accidental duplicate submissions.
- Idempotent reads use bounded retries and timeouts; writes are never blindly retried.

Never commit a Google OAuth client JSON, API key, access token, or refresh token.

## Requirements

- Node.js 22.5 or newer
- A Google account with a YouTube channel for private analytics
- A Google Cloud project with the required YouTube APIs enabled
- macOS, Linux, or Windows
- Xcode Command Line Tools on macOS for the Keychain helper (`xcode-select --install`)

## Installation

```bash
git clone https://github.com/t4god/youtube-creator-mcp.git
cd youtube-creator-mcp
npm ci
npm run build
```

The server can start without credentials and expose status/capability tools. Public
Data API reads require an API key or OAuth; Analytics and private data require OAuth.

## Google Cloud setup

Create a separate Google Cloud project for this installation:

1. Enable **YouTube Data API v3**.
2. Enable **YouTube Analytics API**.
3. Enable **YouTube Reporting API** if you need bulk scheduled reports.
4. Configure the OAuth consent screen.
5. For a personal app, add your Google account as a test user if the project remains in Testing.
6. Create an OAuth client of type **Desktop app**.
7. Download the JSON file outside this repository.

Official references:

- [YouTube Data API](https://developers.google.com/youtube/v3/getting-started)
- [Installed-app OAuth](https://developers.google.com/youtube/v3/guides/auth/installed-apps)
- [YouTube Analytics reports.query](https://developers.google.com/youtube/analytics/reference/reports/query)
- [YouTube Reporting API](https://developers.google.com/youtube/reporting/v1/reports)
- [YouTube API Services policies](https://developers.google.com/youtube/terms/developer-policies)

Do not reuse another person's Google OAuth client. YouTube policies prohibit embedding
shared API credentials in open-source projects.

## Authorize your channel

Start with the minimum read-only profile:

```bash
node dist/cli.js auth --client /absolute/path/to/client_secret.json --profile readonly
```

The command opens Google's authorization page and receives the callback on
`127.0.0.1`. Check the resulting configuration without exposing tokens:

```bash
node dist/cli.js status
```

Remove locally stored credentials:

```bash
node dist/cli.js logout
```

### OAuth profiles

| Profile | Intended use | Added access |
|---|---|---|
| `readonly` | Research and normal analytics | Account reads, analytics reads, memberships |
| `monetary` | Revenue analysis | Adds monetary analytics |
| `manager` | Publishing and channel operations | Adds uploads and management scopes |
| `full` | Creator operations and revenue | Manager plus monetary analytics |
| `partner` | CMS/content-owner accounts only | Adds YouTube Partner scopes |

Changing profiles requires running `auth` again and reviewing the new scopes.

### Credential storage

`YOUTUBE_MCP_SECRET_STORE=auto` is the default:

- macOS: Keychain, encrypted at rest by the operating system
- Linux/Windows: JSON files inside the private application data directory

Set `YOUTUBE_MCP_SECRET_STORE=file` for headless macOS environments. File storage is
protected by local account permissions but is not independently encrypted.

## Connect an MCP client

Replace `/absolute/path/to/youtube-creator-mcp` in these examples.

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.youtube]
command = "node"
args = ["/absolute/path/to/youtube-creator-mcp/dist/cli.js", "serve"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

### Claude Desktop

Add to the `mcpServers` object in the Claude Desktop configuration:

```json
{
  "youtube": {
    "command": "node",
    "args": ["/absolute/path/to/youtube-creator-mcp/dist/cli.js", "serve"]
  }
}
```

### Public API-key-only mode

For public Data API reads without channel analytics:

```json
{
  "youtube": {
    "command": "node",
    "args": ["/absolute/path/to/youtube-creator-mcp/dist/cli.js", "serve"],
    "env": { "YOUTUBE_API_KEY": "YOUR_PERSONAL_API_KEY" }
  }
}
```

Prefer your client's secure environment or secret mechanism instead of writing an API
key directly into a configuration file.

## Tool catalog

### Authentication and discovery

- `youtube_auth_status`
- `youtube_quota_status`
- `youtube_capabilities`

### Public and private Data API reads

- `youtube_my_channel`
- `youtube_get_videos`
- `youtube_get_channels`
- `youtube_channel_uploads`
- `youtube_comments`

Batch ID tools accept up to 500 IDs and issue batches of 50 per API request.

### Analytics

- `youtube_analytics_query`: custom `reports.query` request with named and raw rows
- `youtube_analytics_report`: validated presets

Presets include `channel_overview`, `daily_trends`, `top_videos`, `traffic_sources`,
`search_terms`, `geography`, `devices`, `demographics`, and `retention`.

### Research and local history

- `youtube_topic_research`
- `youtube_compare_topics`
- `youtube_snapshot_videos`
- `youtube_snapshot_history`

Topic results are cached briefly to conserve search quota. Age-normalized views/day is
not current VPH; collect repeated snapshots before claiming real velocity.

### Full API escape hatches

- `youtube_data_read`
- `youtube_data_call`
- `youtube_reporting_read`
- `youtube_reporting_call`
- `youtube_reporting_download`
- `youtube_download_caption`

Use `youtube_capabilities` before a generic call and prefer typed high-level tools.
Generic `videos.insert` and `thumbnails.set` calls are intentionally rejected so uploads cannot
bypass media validation and duplicate protection.

### Creator operations

- `youtube_upload_plan`: validate and hash the exact local file and final metadata without contacting YouTube
- `youtube_upload_video`: private-by-default upload with operation-ID duplicate protection
- `youtube_update_video`: merge-safe metadata, audience, synthetic-media, visibility, and schedule updates
- `youtube_set_thumbnail`: validated JPEG/PNG thumbnail upload (maximum 2 MB)
- `youtube_upload_status`: processing, file, metadata, and visibility status for an owned video
- `youtube_write_audit`: local starts, successes, failures, and deduplicated attempts

Always call `youtube_upload_plan` first and present its exact plan to the channel owner. Use a
stable, unique `operationId` for one intended upload; never reuse it for different content.
Uploads default to `private` even when the caller omits visibility.

## Write safety

Writes are disabled in the server configuration by default. To perform a reviewed write:

1. Authorize with `manager` or `full`.
2. Set `YOUTUBE_MCP_ENABLE_WRITES=true` in the MCP server environment.
3. Include `confirm="APPLY"` in the tool call.

Making a video public or unlisted, scheduling publication, or using a generic live-broadcast
publication action also requires:

```text
YOUTUBE_MCP_ENABLE_PUBLICATION=true
confirm="PUBLISH"
```

Methods such as `delete`, `unset`, or `reportAbuse` additionally require:

```text
YOUTUBE_MCP_ENABLE_DESTRUCTIVE=true
confirm="DELETE"
```

Turn the flags off again after the intended operation. Media operations additionally
require comma-separated absolute directories in `YOUTUBE_MCP_MEDIA_ROOTS`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `YOUTUBE_API_KEY` | unset | Public Data API reads without OAuth |
| `YOUTUBE_MCP_SECRET_STORE` | `auto` | `auto`, `keychain`, or `file` |
| `YOUTUBE_MCP_ENABLE_WRITES` | `false` | Enable non-destructive external writes |
| `YOUTUBE_MCP_ENABLE_PUBLICATION` | `false` | Independently enable public, unlisted, scheduled, and live publication |
| `YOUTUBE_MCP_ENABLE_DESTRUCTIVE` | `false` | Enable destructive external writes |
| `YOUTUBE_MCP_MEDIA_ROOTS` | empty | Allowed upload/download directories |
| `YOUTUBE_MCP_DATA_DIR` | platform application-data directory | Database, cache, exports, file credentials |
| `YOUTUBE_MCP_CACHE_TTL_SECONDS` | `300` | Topic-research cache lifetime |
| `YOUTUBE_MCP_REQUEST_TIMEOUT_MS` | `30000` | Timeout for each idempotent read attempt |
| `YOUTUBE_MCP_MAX_READ_RETRIES` | `3` | Retry count for 429/5xx and transient network read failures |
| `YOUTUBE_MCP_RETRY_BASE_DELAY_MS` | `500` | Exponential backoff base delay with jitter |

On macOS, an existing pre-release data directory at `~/Library/Application Support/youtube-mcp`
is reused automatically so local snapshots and authorization continue working.

## Quotas

The MCP records an estimate of Data API units it consumes. `search.list` and `videos.insert`
are estimated at 100 units each, and all methods draw from the same project quota pool. Google
Cloud Console remains authoritative. Failed calls and read retries may still consume quota,
and quota resets follow Google's Pacific-time schedule.

The ledger does not see calls from other applications using the same Google Cloud project.

## Official API boundaries

Official YouTube APIs do not provide:

- Private analytics or retention for competitors
- Competitor history from before you start collecting snapshots
- Arbitrary third-party video transcripts
- YouTube UI autocomplete
- vidIQ estimates, Google Trends, Reddit, GitHub, or cross-platform signals
- Every action present in YouTube Studio

This MCP is a YouTube data spine, not a complete market-research methodology.

## Development

```bash
npm ci
npm run check
npm test
npm run build
npm run validate
npm run inspect
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[CHANGELOG.md](CHANGELOG.md). Deployment, backup, rotation, and incident procedures are in
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## License

[MIT](LICENSE)
