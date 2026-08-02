#!/usr/bin/env node
import path from "node:path";
import { authStatus, authorize, logout, type AuthProfile } from "./auth.js";
import { serveStdio } from "./server.js";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): string {
  return `YouTube MCP

Usage:
  youtube-mcp serve
  youtube-mcp auth --client /path/to/client_secret.json [--profile readonly|monetary|manager|full|partner]
  youtube-mcp status
  youtube-mcp logout

Profiles:
  readonly  Public/private reads, Analytics, memberships (default)
  monetary Adds estimated revenue and ad metrics
  manager   Adds channel/video/comment/playlist management and uploads
  full      Manager plus monetary analytics
  partner   Full plus YouTube Content Owner scopes
`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "serve";
  switch (command) {
    case "serve":
      await serveStdio();
      return;
    case "auth": {
      const clientPath = valueAfter(args, "--client");
      if (!clientPath) throw new Error("Missing --client /path/to/client_secret.json");
      const profile = (valueAfter(args, "--profile") ?? "readonly") as AuthProfile;
      if (!["readonly", "monetary", "manager", "full", "partner"].includes(profile)) {
        throw new Error(`Unknown profile: ${profile}`);
      }
      const record = await authorize(path.resolve(clientPath), profile);
      process.stdout.write(
        `${JSON.stringify({ ok: true, profile: record.profile, scopes: record.scopes, authorizedAt: record.authorizedAt }, null, 2)}\n`,
      );
      return;
    }
    case "status":
      process.stdout.write(`${JSON.stringify(await authStatus(), null, 2)}\n`);
      return;
    case "logout":
      await logout();
      process.stdout.write("YouTube MCP credentials removed from the configured credential store.\n");
      return;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(usage());
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
