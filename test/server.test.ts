import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

test("MCP initializes, lists its full tool catalog, and serves local quota status", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-mcp-server-test-"));
  const previousDataDir = process.env.YOUTUBE_MCP_DATA_DIR;
  process.env.YOUTUBE_MCP_DATA_DIR = tempDir;
  const { server, store } = createServer();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.length >= 20);
    assert.ok(names.includes("youtube_topic_research"));
    assert.ok(names.includes("youtube_analytics_query"));
    assert.ok(names.includes("youtube_data_call"));
    assert.ok(names.includes("youtube_data_read"));
    assert.ok(names.includes("youtube_reporting_download"));

    const result = await client.callTool({ name: "youtube_quota_status", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as { ok?: boolean })?.ok, true);

    const capabilities = await client.callTool({
      name: "youtube_capabilities",
      arguments: { includeReporting: true },
    });
    const capabilityData = (capabilities.structuredContent as {
      data?: { dataAndLive?: Record<string, string[]>; reporting?: Record<string, string[]> };
    })?.data;
    assert.ok((capabilityData?.dataAndLive?.videos ?? []).includes("list"));
    assert.ok((capabilityData?.reporting?.jobs ?? []).includes("list"));
  } finally {
    await client.close();
    await server.close();
    store.close();
    if (previousDataDir === undefined) delete process.env.YOUTUBE_MCP_DATA_DIR;
    else process.env.YOUTUBE_MCP_DATA_DIR = previousDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
