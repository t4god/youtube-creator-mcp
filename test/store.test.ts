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
    assert.equal(quota.dataUnits, 1);
    assert.equal(quota.searchCalls, 1);
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
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
