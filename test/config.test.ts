import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertWriteEnabled, loadConfig, resolveMediaPath, type AppConfig } from "../src/config.js";
import { McpUserError } from "../src/errors.js";

function baseConfig(root: string): AppConfig {
  return {
    dataDir: root,
    databasePath: path.join(root, "db.sqlite"),
    exportsDir: path.join(root, "exports"),
    enableWrites: false,
    enableDestructive: false,
    mediaRoots: [root],
    cacheTtlSeconds: 300,
    secretStore: "file",
  };
}

test("configuration rejects invalid cache TTL and missing media roots", () => {
  const previous = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-mcp-config-test-"));
  try {
    process.env.YOUTUBE_MCP_DATA_DIR = tempDir;
    process.env.YOUTUBE_MCP_CACHE_TTL_SECONDS = "0";
    assert.throws(() => loadConfig(), (error: unknown) => error instanceof McpUserError && error.code === "invalid_configuration");

    process.env.YOUTUBE_MCP_CACHE_TTL_SECONDS = "300";
    process.env.YOUTUBE_MCP_MEDIA_ROOTS = path.join(tempDir, "missing");
    assert.throws(() => loadConfig(), (error: unknown) => error instanceof McpUserError && error.code === "invalid_media_root");
  } finally {
    process.env = previous;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("media paths reject lexical and symlink escapes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-mcp-path-test-"));
  const allowed = path.join(tempDir, "allowed");
  const outside = path.join(tempDir, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  const insideFile = path.join(allowed, "inside.mp4");
  const outsideFile = path.join(outside, "outside.mp4");
  fs.writeFileSync(insideFile, "inside");
  fs.writeFileSync(outsideFile, "outside");
  fs.symlinkSync(outside, path.join(allowed, "escape"));
  try {
    const config = baseConfig(allowed);
    assert.equal(resolveMediaPath(config, insideFile, true), fs.realpathSync(insideFile));
    assert.throws(() => resolveMediaPath(config, outsideFile, true), /outside YOUTUBE_MCP_MEDIA_ROOTS/);
    assert.throws(() => resolveMediaPath(config, path.join(allowed, "escape", "outside.mp4"), true), /resolves outside/);
    assert.throws(() => resolveMediaPath(config, path.join(allowed, "escape", "new.mp4"), false), /resolves outside/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("write and destructive operations require independent gates", () => {
  const config = baseConfig("/tmp");
  assert.throws(() => assertWriteEnabled(config), (error: unknown) => error instanceof McpUserError && error.code === "writes_disabled");
  const writes = { ...config, enableWrites: true };
  assert.doesNotThrow(() => assertWriteEnabled(writes));
  assert.throws(() => assertWriteEnabled(writes, true), (error: unknown) => error instanceof McpUserError && error.code === "destructive_actions_disabled");
  assert.doesNotThrow(() => assertWriteEnabled({ ...writes, enableDestructive: true }, true));
});
