# Contributing

Contributions are welcome. Keep changes narrow, explain user-visible behavior,
and include tests for new tools and safety-sensitive code.

## Development setup

```bash
npm ci
npm run check
npm test
npm run build
```

The MCP server starts without credentials, so most tool-discovery and local-store
tests do not need access to YouTube. Live API tests must use a personal Google Cloud
project and must never commit credentials or captured private channel data.

## Pull requests

- Open an issue before large architectural changes.
- Preserve read-only defaults and confirmation gates.
- Prefer a high-level, typed tool over expanding generic write behavior.
- Update the README and changelog when behavior changes.
- Run the complete validation suite before requesting review.

By contributing, you agree that your contribution is licensed under the MIT License.
