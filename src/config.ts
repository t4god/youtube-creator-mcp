import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { McpUserError } from "./errors.js";

export interface AppConfig {
  dataDir: string;
  databasePath: string;
  exportsDir: string;
  enableWrites: boolean;
  enablePublication: boolean;
  enableDestructive: boolean;
  mediaRoots: string[];
  apiKey?: string;
  cacheTtlSeconds: number;
  requestTimeoutMs: number;
  maxReadRetries: number;
  retryBaseDelayMs: number;
  secretStore: "auto" | "keychain" | "file";
}

function envBool(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").toLowerCase());
}

function defaultDataDir(): string {
  if (process.platform === "darwin") {
    const parent = path.join(os.homedir(), "Library", "Application Support");
    const current = path.join(parent, "youtube-creator-mcp");
    const legacy = path.join(parent, "youtube-mcp");
    return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "youtube-creator-mcp");
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "youtube-creator-mcp");
}

function parsePositiveInteger(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new McpUserError(`${name} must be a positive integer.`, "invalid_configuration");
  }
  return value;
}

function parseNonNegativeInteger(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new McpUserError(`${name} must be a non-negative integer.`, "invalid_configuration");
  }
  return value;
}

function parseSecretStore(): AppConfig["secretStore"] {
  const value = (process.env.YOUTUBE_MCP_SECRET_STORE ?? "auto").toLowerCase();
  if (value !== "auto" && value !== "keychain" && value !== "file") {
    throw new McpUserError(
      "YOUTUBE_MCP_SECRET_STORE must be auto, keychain, or file.",
      "invalid_configuration",
    );
  }
  if (value === "keychain" && process.platform !== "darwin") {
    throw new McpUserError(
      "The keychain credential store is only available on macOS.",
      "unsupported_credential_store",
    );
  }
  return value;
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(
    process.env.YOUTUBE_MCP_DATA_DIR ??
      defaultDataDir(),
  );
  const roots = (process.env.YOUTUBE_MCP_MEDIA_ROOTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
  for (const root of roots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new McpUserError(
        `YOUTUBE_MCP_MEDIA_ROOTS contains a missing or non-directory path: ${root}`,
        "invalid_media_root",
      );
    }
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const exportsDir = path.join(dataDir, "exports");
  fs.mkdirSync(exportsDir, { recursive: true, mode: 0o700 });

  return {
    dataDir,
    databasePath: path.join(dataDir, "youtube.sqlite"),
    exportsDir,
    enableWrites: envBool("YOUTUBE_MCP_ENABLE_WRITES"),
    enablePublication: envBool("YOUTUBE_MCP_ENABLE_PUBLICATION"),
    enableDestructive: envBool("YOUTUBE_MCP_ENABLE_DESTRUCTIVE"),
    mediaRoots: roots,
    ...(process.env.YOUTUBE_API_KEY ? { apiKey: process.env.YOUTUBE_API_KEY } : {}),
    cacheTtlSeconds: parsePositiveInteger("YOUTUBE_MCP_CACHE_TTL_SECONDS", 300),
    requestTimeoutMs: parsePositiveInteger("YOUTUBE_MCP_REQUEST_TIMEOUT_MS", 30_000),
    maxReadRetries: parseNonNegativeInteger("YOUTUBE_MCP_MAX_READ_RETRIES", 3),
    retryBaseDelayMs: parsePositiveInteger("YOUTUBE_MCP_RETRY_BASE_DELAY_MS", 500),
    secretStore: parseSecretStore(),
  };
}

export function assertPublicationEnabled(config: AppConfig): void {
  assertWriteEnabled(config);
  if (!config.enablePublication) {
    throw new McpUserError(
      "Publishing or scheduling is disabled. Set YOUTUBE_MCP_ENABLE_PUBLICATION=true only after reviewing the final video and metadata.",
      "publication_disabled",
    );
  }
}

export function assertWriteEnabled(config: AppConfig, destructive = false): void {
  if (!config.enableWrites) {
    throw new McpUserError(
      "YouTube writes are disabled. Set YOUTUBE_MCP_ENABLE_WRITES=true in the MCP server environment after reviewing the requested action.",
      "writes_disabled",
    );
  }
  if (destructive && !config.enableDestructive) {
    throw new McpUserError(
      "Destructive YouTube actions are disabled. Set YOUTUBE_MCP_ENABLE_DESTRUCTIVE=true only for the specific operation, then disable it again.",
      "destructive_actions_disabled",
    );
  }
}

export function resolveMediaPath(config: AppConfig, inputPath: string, mustExist: boolean): string {
  const resolved = path.resolve(inputPath);
  const isWithin = (candidate: string, root: string) =>
    candidate === root || candidate.startsWith(`${root}${path.sep}`);
  const matchingRoot = config.mediaRoots.find((root) => isWithin(resolved, root));
  if (!matchingRoot) {
    throw new McpUserError(
      `Path is outside YOUTUBE_MCP_MEDIA_ROOTS: ${resolved}`,
      "media_path_not_allowed",
      { allowedRoots: config.mediaRoots },
    );
  }
  if (mustExist && !fs.existsSync(resolved)) {
    throw new McpUserError(`Media file does not exist: ${resolved}`, "file_not_found");
  }

  const realRoot = fs.realpathSync(matchingRoot);
  if (mustExist) {
    const realPath = fs.realpathSync(resolved);
    if (!isWithin(realPath, realRoot)) {
      throw new McpUserError(
        `Media path resolves outside YOUTUBE_MCP_MEDIA_ROOTS: ${resolved}`,
        "media_path_not_allowed",
        { allowedRoots: config.mediaRoots },
      );
    }
    return realPath;
  }

  let existingAncestor = path.dirname(resolved);
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const realAncestor = fs.realpathSync(existingAncestor);
  if (!isWithin(realAncestor, realRoot)) {
    throw new McpUserError(
      `Media output path resolves outside YOUTUBE_MCP_MEDIA_ROOTS: ${resolved}`,
      "media_path_not_allowed",
      { allowedRoots: config.mediaRoots },
    );
  }
  return path.join(realAncestor, path.relative(existingAncestor, resolved));
}
