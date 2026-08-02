import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { McpUserError } from "../src/errors.js";
import { operationCost, retryableReadError, retryDelayMs, YouTubeClient } from "../src/google.js";
import { Store } from "../src/store.js";

function config(root: string): AppConfig {
  return {
    dataDir: root,
    databasePath: path.join(root, "db.sqlite"),
    exportsDir: root,
    enableWrites: true,
    enablePublication: false,
    enableDestructive: false,
    mediaRoots: [root],
    cacheTtlSeconds: 300,
    requestTimeoutMs: 1_000,
    maxReadRetries: 2,
    retryBaseDelayMs: 10,
    secretStore: "file",
  };
}

test("quota costs and retry classification use YouTube semantics", () => {
  assert.deepEqual(operationCost("search", "list"), { bucket: "search", cost: 100 });
  assert.deepEqual(operationCost("videos", "insert"), { bucket: "upload", cost: 100 });
  assert.equal(retryableReadError({ response: { status: 503 } }), true);
  assert.equal(retryableReadError({ response: { status: 400 } }), false);
  assert.equal(retryDelayMs(0, 500, "2"), 2_000);
});

test("generic calls cannot bypass the publication gate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-mcp-google-test-"));
  const store = new Store(path.join(root, "db.sqlite"));
  try {
    const client = new YouTubeClient(config(root), store);
    await assert.rejects(
      client.dataCall({
        resource: "videos",
        method: "update",
        params: { requestBody: { status: { privacyStatus: "public" } } },
        confirm: "PUBLISH",
      }),
      (error: unknown) => error instanceof McpUserError && error.code === "publication_disabled",
    );
    await assert.rejects(
      client.dataCall({
        resource: "videos",
        method: "insert",
        body: { status: { privacyStatus: "private" } },
        confirm: "APPLY",
      }),
      (error: unknown) => error instanceof McpUserError && error.code === "typed_tool_required",
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("idempotent reads retry transient failures and record each quota attempt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-mcp-retry-test-"));
  const store = new Store(path.join(root, "db.sqlite"));
  try {
    const client = new YouTubeClient(config(root), store);
    let calls = 0;
    const result = await client.executeRead("videos", "list", async () => {
      calls += 1;
      if (calls < 3) throw { response: { status: 503, headers: { "retry-after": "0" } } };
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(calls, 3);
    assert.equal(store.quotaToday().estimatedUnits, 3);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
