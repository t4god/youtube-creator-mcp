import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deleteSecret, getSecret, secretStoreStatus, setSecret } from "../src/secrets.js";

test("file credential store persists and deletes secrets privately", async () => {
  const previousDataDir = process.env.YOUTUBE_MCP_DATA_DIR;
  const previousStore = process.env.YOUTUBE_MCP_SECRET_STORE;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-mcp-secret-test-"));
  process.env.YOUTUBE_MCP_DATA_DIR = tempDir;
  process.env.YOUTUBE_MCP_SECRET_STORE = "file";
  try {
    assert.deepEqual(secretStoreStatus(), { backend: "file", encryptedAtRest: false });
    await setSecret("test.service", { token: "not-a-real-token" });
    assert.deepEqual(await getSecret("test.service"), { token: "not-a-real-token" });
    const files = fs.readdirSync(path.join(tempDir, "secrets"));
    assert.equal(files.length, 1);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(tempDir, "secrets", files[0]!)).mode & 0o777, 0o600);
    }
    await deleteSecret("test.service");
    assert.equal(await getSecret("test.service"), null);
  } finally {
    if (previousDataDir === undefined) delete process.env.YOUTUBE_MCP_DATA_DIR;
    else process.env.YOUTUBE_MCP_DATA_DIR = previousDataDir;
    if (previousStore === undefined) delete process.env.YOUTUBE_MCP_SECRET_STORE;
    else process.env.YOUTUBE_MCP_SECRET_STORE = previousStore;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
