import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";

test("store persists snapshots and calculates local quota", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-mcp-test-"));
  const store = new Store(path.join(tempDir, "test.sqlite"));
  try {
    store.recordQuota("videos.list", "data", 1);
    store.recordQuota("search.list", "search", 1);
    const quota = store.quotaToday();
    assert.equal(quota.estimatedUnits, 2);
    assert.equal(quota.otherDataUnits, 1);
    assert.equal(quota.searchUnits, 1);
    assert.equal(quota.calls, 2);

    store.saveSnapshots([
      {
        videoId: "abc",
        channelId: "channel",
        title: "Test",
        publishedAt: "2026-01-01T00:00:00Z",
        viewCount: 100,
        likeCount: 10,
        commentCount: 2,
        capturedAt: "2026-08-01T00:00:00Z",
      },
      {
        videoId: "abc",
        channelId: "channel",
        title: "Test",
        publishedAt: "2026-01-01T00:00:00Z",
        viewCount: 140,
        likeCount: 12,
        commentCount: 3,
        capturedAt: "2026-08-02T00:00:00Z",
      },
    ]);
    const history = store.snapshotHistory(["abc"]);
    assert.equal(history.length, 2);
    assert.equal(history[0]?.viewCount, 140);

    store.setCache("key", { value: 1 }, 60);
    assert.deepEqual(store.getCache("key"), { value: 1 });

    const first = store.beginUploadOperation("operation-1", "fingerprint-1");
    assert.equal(first.created, true);
    const duplicate = store.beginUploadOperation("operation-1", "fingerprint-1");
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.operation.state, "in_progress");
    store.completeUploadOperation("operation-1", "video-1", { id: "video-1" });
    assert.equal(store.getUploadOperation("operation-1")?.state, "completed");

    store.recordWriteAudit({
      operation: "videos.insert",
      target: "video-1",
      confirmation: "APPLY",
      outcome: "succeeded",
    });
    assert.equal(store.writeAudit(1)[0]?.["target"], "video-1");
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
