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
  const previousMediaRoots = process.env.YOUTUBE_MCP_MEDIA_ROOTS;
  const previousWrites = process.env.YOUTUBE_MCP_ENABLE_WRITES;
  const previousPublication = process.env.YOUTUBE_MCP_ENABLE_PUBLICATION;
  process.env.YOUTUBE_MCP_DATA_DIR = tempDir;
  process.env.YOUTUBE_MCP_MEDIA_ROOTS = tempDir;
  process.env.YOUTUBE_MCP_ENABLE_WRITES = "false";
  process.env.YOUTUBE_MCP_ENABLE_PUBLICATION = "false";
  const videoPath = path.join(tempDir, "sample.mp4");
  fs.writeFileSync(videoPath, "test video bytes");
  const { server, store } = createServer();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.length >= 26);
    assert.ok(names.includes("youtube_topic_research"));
    assert.ok(names.includes("youtube_analytics_query"));
    assert.ok(names.includes("youtube_data_call"));
    assert.ok(names.includes("youtube_data_read"));
    assert.ok(names.includes("youtube_reporting_download"));
    assert.ok(names.includes("youtube_upload_plan"));
    assert.ok(names.includes("youtube_upload_video"));
    assert.ok(names.includes("youtube_write_audit"));

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

    const plan = await client.callTool({
      name: "youtube_upload_plan",
      arguments: {
        mediaPath: videoPath,
        title: "A private test upload",
        operationId: "test-operation-001",
      },
    });
    assert.equal(plan.isError, undefined);
    const planData = (plan.structuredContent as { data?: { requiredConfirmation?: string } })?.data;
    assert.equal(planData?.requiredConfirmation, "APPLY");

    const publicPlan = await client.callTool({
      name: "youtube_upload_plan",
      arguments: {
        mediaPath: videoPath,
        title: "A public test upload",
        privacyStatus: "public",
        operationId: "test-operation-002",
      },
    });
    const publicPlanData = (publicPlan.structuredContent as { data?: { requiredConfirmation?: string } })?.data;
    assert.equal(publicPlanData?.requiredConfirmation, "PUBLISH");

    const blockedUpload = await client.callTool({
      name: "youtube_upload_video",
      arguments: {
        mediaPath: videoPath,
        title: "A blocked test upload",
        operationId: "test-operation-003",
        confirm: "APPLY",
      },
    });
    assert.equal(blockedUpload.isError, true);
    assert.equal(
      (blockedUpload.structuredContent as { error?: { code?: string } })?.error?.code,
      "writes_disabled",
    );
  } finally {
    await client.close();
    await server.close();
    store.close();
    if (previousDataDir === undefined) delete process.env.YOUTUBE_MCP_DATA_DIR;
    else process.env.YOUTUBE_MCP_DATA_DIR = previousDataDir;
    if (previousMediaRoots === undefined) delete process.env.YOUTUBE_MCP_MEDIA_ROOTS;
    else process.env.YOUTUBE_MCP_MEDIA_ROOTS = previousMediaRoots;
    if (previousWrites === undefined) delete process.env.YOUTUBE_MCP_ENABLE_WRITES;
    else process.env.YOUTUBE_MCP_ENABLE_WRITES = previousWrites;
    if (previousPublication === undefined) delete process.env.YOUTUBE_MCP_ENABLE_PUBLICATION;
    else process.env.YOUTUBE_MCP_ENABLE_PUBLICATION = previousPublication;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
