import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { CreatorService } from "../src/creator-service.js";
import { Store } from "../src/store.js";
import { YouTubeClient } from "../src/google.js";

test("upload planning is private by default and fingerprints content plus metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-mcp-creator-test-"));
  const mediaPath = path.join(root, "video.mp4");
  fs.writeFileSync(mediaPath, "video bytes");
  const config: AppConfig = {
    dataDir: root,
    databasePath: path.join(root, "db.sqlite"),
    exportsDir: root,
    enableWrites: false,
    enablePublication: false,
    enableDestructive: false,
    mediaRoots: [root],
    cacheTtlSeconds: 300,
    requestTimeoutMs: 30_000,
    maxReadRetries: 3,
    retryBaseDelayMs: 500,
    secretStore: "file",
  };
  const store = new Store(config.databasePath);
  try {
    const service = new CreatorService(config, store, new YouTubeClient(config, store));
    const plan = await service.uploadPlan({
      mediaPath,
      title: "Production-safe upload",
      operationId: "upload-operation-001",
    });
    assert.equal((plan["metadata"] as Record<string, unknown>)["privacyStatus"], "private");
    assert.equal(plan["requiredConfirmation"], "APPLY");
    assert.match(String(plan["fingerprint"]), /^[a-f0-9]{64}$/);

    await assert.rejects(
      service.uploadPlan({
        mediaPath,
        title: "x".repeat(101),
        operationId: "upload-operation-002",
      }),
      /title must contain 1-100/,
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
