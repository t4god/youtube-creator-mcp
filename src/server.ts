import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { authStatus } from "./auth.js";
import { loadConfig, resolveMediaPath } from "./config.js";
import { Store } from "./store.js";
import { YouTubeClient } from "./google.js";
import { DataService } from "./data-service.js";
import { AnalyticsService } from "./analytics-service.js";
import { ResearchService } from "./research-service.js";
import { ReportingService } from "./reporting-service.js";
import { CreatorService } from "./creator-service.js";
import { toolError, toolResult } from "./result.js";

const readAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const writeAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const safeWriteAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const localWriteAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

function handler<T>(fn: (args: T) => Promise<unknown> | unknown) {
  return async (args: T) => {
    try {
      return toolResult(await fn(args));
    } catch (error) {
      return toolError(error);
    }
  };
}

export function createServer() {
  const config = loadConfig();
  const store = new Store(config.databasePath);
  const client = new YouTubeClient(config, store);
  const data = new DataService(client, store);
  const analytics = new AnalyticsService(client);
  const research = new ResearchService(config, store, client, data);
  const reporting = new ReportingService(config, client, store);
  const creator = new CreatorService(config, store, client);

  const server = new McpServer(
    { name: "youtube-mcp", version: "0.2.0" },
    {
      instructions:
        "Use high-level tools before generic API calls. Search is quota-expensive, so reuse cached topic research when possible. Snapshot competitor videos repeatedly before claiming true velocity. Writes are disabled by default. Publishing has an independent gate and requires PUBLISH; ordinary writes require APPLY; destructive actions require DELETE. Never bypass final user review. Analytics and private channel data require OAuth. Do not expose OAuth tokens, client secrets, or Keychain contents.",
    },
  );

  server.registerTool(
    "youtube_auth_status",
    {
      title: "YouTube authorization status",
      description: "Check whether OAuth is configured and which capability profile/scopes are active. Never returns credentials.",
      inputSchema: z.object({}),
      annotations: readAnnotations,
    },
    handler(async () => ({
      ...(await authStatus()),
      authProfiles: ["readonly", "monetary", "manager", "full", "partner"],
      safety: {
        writesEnabled: config.enableWrites,
        publicationEnabled: config.enablePublication,
        destructiveEnabled: config.enableDestructive,
        allowedMediaRoots: config.mediaRoots,
      },
    })),
  );

  server.registerTool(
    "youtube_quota_status",
    {
      title: "Local YouTube quota estimate",
      description: "Show calls recorded by this MCP today. This is an estimate, not the Google Cloud project's authoritative quota usage.",
      inputSchema: z.object({}),
      annotations: readAnnotations,
    },
    handler(() => ({
      localEstimate: store.quotaToday(),
      typicalDefaultDailyQuotaUnits: 10_000,
      note: "All Data API methods consume the same project quota pool; search.list and videos.insert are estimated at 100 units each.",
      resetTimezone: "America/Los_Angeles",
    })),
  );

  server.registerTool(
    "youtube_capabilities",
    {
      title: "YouTube MCP capabilities",
      description: "List the Data/Live and Reporting API resources and methods available through the installed Google client.",
      inputSchema: z.object({ includeReporting: z.boolean().default(true) }),
      annotations: readAnnotations,
    },
    handler(async ({ includeReporting }: { includeReporting: boolean }) => ({
      dataAndLive: await client.capabilities(),
      ...(includeReporting ? { reporting: await reporting.capabilities() } : {}),
      highLevelTools: [
        "youtube_my_channel",
        "youtube_get_videos",
        "youtube_get_channels",
        "youtube_channel_uploads",
        "youtube_comments",
        "youtube_post_comment",
        "youtube_reply_to_comment",
        "youtube_update_comment",
        "youtube_moderate_comment",
        "youtube_delete_comment",
        "youtube_analytics_query",
        "youtube_analytics_report",
        "youtube_topic_research",
        "youtube_compare_topics",
        "youtube_snapshot_videos",
        "youtube_snapshot_history",
        "youtube_upload_plan",
        "youtube_upload_video",
        "youtube_update_video",
        "youtube_set_thumbnail",
        "youtube_upload_status",
        "youtube_write_audit",
        "youtube_data_read",
        "youtube_reporting_read",
      ],
    })),
  );

  server.registerTool(
    "youtube_my_channel",
    {
      title: "My YouTube channel",
      description: "Get the authenticated channel's metadata, public statistics, uploads playlist, status, and branding settings.",
      inputSchema: z.object({}),
      annotations: readAnnotations,
    },
    handler(() => data.myChannel()),
  );

  server.registerTool(
    "youtube_get_videos",
    {
      title: "Get YouTube videos",
      description: "Batch-fetch up to 500 video resources by ID, 50 per API request.",
      inputSchema: z.object({
        videoIds: z.array(z.string().min(1)).min(1).max(500),
        parts: z.array(z.string()).optional(),
      }),
      annotations: readAnnotations,
    },
    handler(({ videoIds, parts }: { videoIds: string[]; parts?: string[] }) => data.videos(videoIds, parts)),
  );

  server.registerTool(
    "youtube_get_channels",
    {
      title: "Get YouTube channels",
      description: "Batch-fetch up to 500 channel resources by ID, including subscriber/view/video counts and uploads playlist IDs.",
      inputSchema: z.object({
        channelIds: z.array(z.string().min(1)).min(1).max(500),
        parts: z.array(z.string()).optional(),
      }),
      annotations: readAnnotations,
    },
    handler(({ channelIds, parts }: { channelIds: string[]; parts?: string[] }) => data.channels(channelIds, parts)),
  );

  server.registerTool(
    "youtube_channel_uploads",
    {
      title: "YouTube channel uploads",
      description: "List a public or authenticated channel's uploads with fully hydrated video statistics.",
      inputSchema: z.object({
        channelId: z.string().optional(),
        mine: z.boolean().default(false),
        maxResults: z.number().int().min(1).max(50).default(50),
        pageToken: z.string().optional(),
      }).refine((value) => value.mine || Boolean(value.channelId), { message: "Provide channelId or set mine=true." }),
      annotations: readAnnotations,
    },
    handler((args: { channelId?: string; mine: boolean; maxResults: number; pageToken?: string }) => data.channelUploads(args)),
  );

  server.registerTool(
    "youtube_comments",
    {
      title: "YouTube comments",
      description: "List comment threads and included replies for a video or channel, with optional text search and owner moderation filters.",
      inputSchema: z.object({
        videoId: z.string().optional(),
        channelId: z.string().optional(),
        allThreadsRelatedToChannelId: z.string().optional(),
        maxResults: z.number().int().min(1).max(100).default(100),
        pageToken: z.string().optional(),
        order: z.enum(["time", "relevance"]).default("relevance"),
        searchTerms: z.string().optional(),
        moderationStatus: z.enum(["heldForReview", "likelySpam", "published"]).optional(),
      }).refine(
        (value) => Boolean(value.videoId || value.channelId || value.allThreadsRelatedToChannelId),
        { message: "Provide videoId, channelId, or allThreadsRelatedToChannelId." },
      ),
      annotations: readAnnotations,
    },
    handler((args: Parameters<DataService["comments"]>[0]) => data.comments(args)),
  );

  server.registerTool(
    "youtube_post_comment",
    {
      title: "Post a YouTube comment",
      description: "Post a new top-level comment on a video. Requires the write gate and confirm=\"APPLY\".",
      inputSchema: z.object({
        videoId: z.string().min(1),
        text: z.string().min(1).max(10_000),
        channelId: z.string().optional(),
        confirm: z.literal("APPLY").optional(),
      }),
      annotations: safeWriteAnnotations,
    },
    handler(({ videoId, text, channelId, confirm }: {
      videoId: string; text: string; channelId?: string; confirm?: "APPLY";
    }) => client.dataCall({
      resource: "commentThreads",
      method: "insert",
      params: { part: ["snippet"] },
      body: {
        snippet: {
          videoId,
          ...(channelId ? { channelId } : {}),
          topLevelComment: { snippet: { textOriginal: text } },
        },
      },
      confirm,
    })),
  );

  server.registerTool(
    "youtube_reply_to_comment",
    {
      title: "Reply to a YouTube comment",
      description: "Reply within an existing top-level comment thread. Requires the write gate and confirm=\"APPLY\".",
      inputSchema: z.object({
        parentId: z.string().min(1),
        text: z.string().min(1).max(10_000),
        confirm: z.literal("APPLY").optional(),
      }),
      annotations: safeWriteAnnotations,
    },
    handler(({ parentId, text, confirm }: { parentId: string; text: string; confirm?: "APPLY" }) =>
      client.dataCall({
        resource: "comments",
        method: "insert",
        params: { part: ["snippet"] },
        body: { snippet: { parentId, textOriginal: text } },
        confirm,
      })),
  );

  server.registerTool(
    "youtube_update_comment",
    {
      title: "Update a YouTube comment",
      description: "Edit a comment or reply owned by the authenticated channel. Requires the write gate and confirm=\"APPLY\".",
      inputSchema: z.object({
        commentId: z.string().min(1),
        text: z.string().min(1).max(10_000),
        confirm: z.literal("APPLY").optional(),
      }),
      annotations: safeWriteAnnotations,
    },
    handler(({ commentId, text, confirm }: { commentId: string; text: string; confirm?: "APPLY" }) =>
      client.dataCall({
        resource: "comments",
        method: "update",
        params: { part: ["snippet"] },
        body: { id: commentId, snippet: { textOriginal: text } },
        confirm,
      })),
  );

  server.registerTool(
    "youtube_moderate_comment",
    {
      title: "Moderate a YouTube comment",
      description: "Publish, hold, or reject a comment on the authenticated channel. Optionally ban the author when rejecting. Requires the write gate and confirm=\"APPLY\".",
      inputSchema: z.object({
        commentId: z.string().min(1),
        moderationStatus: z.enum(["published", "heldForReview", "rejected"]),
        banAuthor: z.boolean().default(false),
        confirm: z.literal("APPLY").optional(),
      }).superRefine((value, ctx) => {
        if (value.banAuthor && value.moderationStatus !== "rejected") {
          ctx.addIssue({
            code: "custom",
            path: ["banAuthor"],
            message: "banAuthor can only be used with moderationStatus=\"rejected\".",
          });
        }
      }),
      annotations: safeWriteAnnotations,
    },
    handler(({ commentId, moderationStatus, banAuthor, confirm }: {
      commentId: string;
      moderationStatus: "published" | "heldForReview" | "rejected";
      banAuthor: boolean;
      confirm?: "APPLY";
    }) => client.dataCall({
      resource: "comments",
      method: "setModerationStatus",
      params: {
        id: commentId,
        moderationStatus,
        ...(banAuthor ? { banAuthor: true } : {}),
      },
      confirm,
    })),
  );

  server.registerTool(
    "youtube_delete_comment",
    {
      title: "Delete a YouTube comment",
      description: "Permanently delete a comment owned by the authenticated channel. Requires destructive actions to be enabled and confirm=\"DELETE\".",
      inputSchema: z.object({
        commentId: z.string().min(1),
        confirm: z.literal("DELETE").optional(),
      }),
      annotations: writeAnnotations,
    },
    handler(({ commentId, confirm }: { commentId: string; confirm?: "DELETE" }) => client.dataCall({
      resource: "comments",
      method: "delete",
      params: { id: commentId },
      confirm,
    })),
  );

  server.registerTool(
    "youtube_analytics_query",
    {
      title: "Query YouTube Analytics",
      description: "Run a fully custom YouTube Analytics reports.query request and return both named rows and raw rows.",
      inputSchema: z.object({
        ids: z.string().default("channel==MINE"),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        metrics: z.string().min(1),
        dimensions: z.string().optional(),
        filters: z.string().optional(),
        sort: z.string().optional(),
        maxResults: z.number().int().positive().optional(),
        startIndex: z.number().int().positive().optional(),
        currency: z.string().length(3).optional(),
        includeHistoricalChannelData: z.boolean().optional(),
      }),
      annotations: readAnnotations,
    },
    handler((args: Parameters<AnalyticsService["query"]>[0]) => analytics.query(args)),
  );

  server.registerTool(
    "youtube_analytics_report",
    {
      title: "YouTube Analytics report",
      description: "Run a validated high-level report: overview, trends, top videos, traffic sources, search terms, geography, devices, demographics, or retention.",
      inputSchema: z.object({
        report: z.enum([
          "channel_overview",
          "daily_trends",
          "top_videos",
          "traffic_sources",
          "search_terms",
          "geography",
          "devices",
          "demographics",
          "retention",
        ]),
        days: z.number().int().min(1).max(3650).default(28),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        videoId: z.string().optional(),
        maxResults: z.number().int().positive().max(500).default(50),
        monetary: z.boolean().default(false),
        currency: z.string().length(3).optional(),
      }),
      annotations: readAnnotations,
    },
    handler((args: Parameters<AnalyticsService["preset"]>[0]) => analytics.preset(args)),
  );

  const topicSchema = z.object({
    query: z.string().min(1),
    days: z.number().int().min(1).max(3650).default(90),
    maxResults: z.number().int().min(1).max(50).default(25),
    order: z.enum(["date", "rating", "relevance", "title", "videoCount", "viewCount"]).default("relevance"),
    regionCode: z.string().length(2).optional(),
    relevanceLanguage: z.string().optional(),
    videoDuration: z.enum(["any", "long", "medium", "short"]).optional(),
    publishedAfter: z.string().datetime().optional(),
    publishedBefore: z.string().datetime().optional(),
    forceRefresh: z.boolean().default(false),
  });

  server.registerTool(
    "youtube_topic_research",
    {
      title: "Research a YouTube topic",
      description: "Sample current topic results, hydrate video/channel stats, and calculate demand, velocity proxies, competition, and breakout indicators. Cached briefly to protect search quota.",
      inputSchema: topicSchema,
      annotations: readAnnotations,
    },
    handler((args: Parameters<ResearchService["topic"]>[0]) => research.topic(args)),
  );

  server.registerTool(
    "youtube_compare_topics",
    {
      title: "Compare YouTube topics",
      description: "Research and rank 2-8 topic samples using the same methodology and median views/day basis.",
      inputSchema: z.object({ topics: z.array(topicSchema).min(2).max(8) }),
      annotations: readAnnotations,
    },
    handler(({ topics }: { topics: Parameters<ResearchService["topic"]>[0][] }) => research.compare(topics)),
  );

  server.registerTool(
    "youtube_snapshot_videos",
    {
      title: "Snapshot YouTube video statistics",
      description: "Fetch and persist current view/like/comment counts for up to 500 videos for longitudinal competitor and velocity tracking.",
      inputSchema: z.object({ videoIds: z.array(z.string().min(1)).min(1).max(500) }),
      annotations: localWriteAnnotations,
    },
    handler(({ videoIds }: { videoIds: string[] }) => data.snapshot(videoIds)),
  );

  server.registerTool(
    "youtube_snapshot_history",
    {
      title: "YouTube video snapshot history",
      description: "Read stored snapshots and calculate deltas and views/hour between captures.",
      inputSchema: z.object({
        videoIds: z.array(z.string().min(1)).min(1).max(500),
        limitPerVideo: z.number().int().min(2).max(365).default(30),
      }),
      annotations: readAnnotations,
    },
    handler(({ videoIds, limitPerVideo }: { videoIds: string[]; limitPerVideo: number }) => data.history(videoIds, limitPerVideo)),
  );

  const uploadSchema = z.object({
    mediaPath: z.string().min(1),
    title: z.string().min(1).max(100),
    description: z.string().max(5_000).optional(),
    tags: z.array(z.string().min(1)).max(500).optional(),
    categoryId: z.string().regex(/^\d+$/).optional(),
    privacyStatus: z.enum(["private", "unlisted", "public"]).default("private"),
    publishAt: z.string().datetime().optional(),
    selfDeclaredMadeForKids: z.boolean().optional(),
    containsSyntheticMedia: z.boolean().optional(),
    notifySubscribers: z.boolean().default(true),
    operationId: z.string().min(8).max(128),
    confirm: z.enum(["APPLY", "PUBLISH"]).optional(),
  });

  server.registerTool(
    "youtube_upload_plan",
    {
      title: "Preview a YouTube video upload",
      description: "Validate an allowed local video, hash its content and final metadata, detect a reused operation ID, and show the exact gates required. Does not contact YouTube or mutate state.",
      inputSchema: uploadSchema,
      annotations: readAnnotations,
    },
    handler((args: Parameters<CreatorService["uploadPlan"]>[0]) => creator.uploadPlan(args)),
  );

  server.registerTool(
    "youtube_upload_video",
    {
      title: "Upload a YouTube video",
      description: "Upload a validated local video with duplicate protection. Defaults to private and requires APPLY. Public, unlisted, or scheduled uploads additionally require the publication gate and PUBLISH.",
      inputSchema: uploadSchema,
      annotations: safeWriteAnnotations,
    },
    handler((args: Parameters<CreatorService["upload"]>[0]) => creator.upload(args)),
  );

  server.registerTool(
    "youtube_update_video",
    {
      title: "Update YouTube video metadata or visibility",
      description: "Safely merge selected metadata/status fields into the current video. Publishing, unlisting, or scheduling requires the independent publication gate and PUBLISH.",
      inputSchema: z.object({
        videoId: z.string().min(1),
        title: z.string().min(1).max(100).optional(),
        description: z.string().max(5_000).optional(),
        tags: z.array(z.string().min(1)).max(500).optional(),
        categoryId: z.string().regex(/^\d+$/).optional(),
        privacyStatus: z.enum(["private", "unlisted", "public"]).optional(),
        publishAt: z.string().datetime().nullable().optional(),
        selfDeclaredMadeForKids: z.boolean().optional(),
        containsSyntheticMedia: z.boolean().optional(),
        confirm: z.enum(["APPLY", "PUBLISH"]).optional(),
      }),
      annotations: safeWriteAnnotations,
    },
    handler((args: Parameters<CreatorService["updateVideo"]>[0]) => creator.updateVideo(args)),
  );

  server.registerTool(
    "youtube_set_thumbnail",
    {
      title: "Set a YouTube video thumbnail",
      description: "Set a validated JPEG/PNG thumbnail up to 2 MB from an allowed media root. Requires the write gate and APPLY.",
      inputSchema: z.object({
        videoId: z.string().min(1),
        imagePath: z.string().min(1),
        confirm: z.literal("APPLY").optional(),
      }),
      annotations: safeWriteAnnotations,
    },
    handler((args: Parameters<CreatorService["setThumbnail"]>[0]) => creator.setThumbnail(args)),
  );

  server.registerTool(
    "youtube_upload_status",
    {
      title: "Check YouTube upload processing",
      description: "Read upload processing, file, metadata, and visibility status for an owned video.",
      inputSchema: z.object({ videoId: z.string().min(1) }),
      annotations: readAnnotations,
    },
    handler(({ videoId }: { videoId: string }) => creator.uploadStatus(videoId)),
  );

  server.registerTool(
    "youtube_write_audit",
    {
      title: "Read the local YouTube write audit",
      description: "Review locally recorded starts, successes, failures, and deduplicated upload attempts. Does not include OAuth credentials or media content.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
      annotations: readAnnotations,
    },
    handler(({ limit }: { limit: number }) => store.writeAudit(limit)),
  );

  server.registerTool(
    "youtube_data_read",
    {
      title: "Read any YouTube Data or Live API resource",
      description: "Read-only escape hatch for list/get/getRating/download/streamList methods exposed by googleapis.youtube(v3). Use youtube_capabilities first.",
      inputSchema: z.object({
        resource: z.string().min(1),
        method: z.enum(["list", "get", "getRating", "download", "streamList"]),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
      annotations: readAnnotations,
    },
    handler((args: Parameters<YouTubeClient["dataRead"]>[0]) => client.dataRead(args)),
  );

  server.registerTool(
    "youtube_data_call",
    {
      title: "Call any YouTube Data or Live API method",
      description: "Guarded escape hatch for methods exposed by googleapis.youtube(v3). Reads work normally; writes require APPLY, publishing/scheduling requires PUBLISH, and destructive methods require DELETE. Video and thumbnail media writes must use their typed tools.",
      inputSchema: z.object({
        resource: z.string().min(1),
        method: z.string().min(1),
        params: z.record(z.string(), z.unknown()).optional(),
        body: z.record(z.string(), z.unknown()).optional(),
        mediaPath: z.string().optional(),
        confirm: z.enum(["APPLY", "PUBLISH", "DELETE"]).optional(),
      }),
      annotations: writeAnnotations,
    },
    handler((args: Parameters<YouTubeClient["dataCall"]>[0]) => client.dataCall(args)),
  );

  server.registerTool(
    "youtube_download_caption",
    {
      title: "Download a YouTube caption track",
      description: "Download an authorized caption track to an allowed local media path. Use captions.list through youtube_data_call to find the caption ID.",
      inputSchema: z.object({
        captionId: z.string().min(1),
        outputPath: z.string().min(1),
        format: z.enum(["sbv", "scc", "srt", "ttml", "vtt"]).default("vtt"),
        language: z.string().optional(),
        overwrite: z.boolean().default(false),
      }),
      annotations: localWriteAnnotations,
    },
    handler(async ({ captionId, outputPath, format, language, overwrite }: {
      captionId: string; outputPath: string; format: "sbv" | "scc" | "srt" | "ttml" | "vtt"; language?: string; overwrite: boolean;
    }) => {
      const resolved = resolveMediaPath(config, outputPath, false);
      fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
      if (fs.existsSync(resolved) && !overwrite) throw new Error(`Output file exists: ${resolved}`);
      const { youtube } = await client.context(true);
      const response = await client.executeRead(
        "captions",
        "download",
        (options) => youtube.captions.download(
          { id: captionId, tfmt: format, ...(language ? { tlang: language } : {}) },
          { ...options, responseType: "stream" },
        ),
      );
      await pipeline(response.data, fs.createWriteStream(resolved, { flags: overwrite ? "w" : "wx", mode: 0o600 }));
      return { outputPath: resolved, bytes: fs.statSync(resolved).size };
    }),
  );

  server.registerTool(
    "youtube_reporting_read",
    {
      title: "Read YouTube Reporting API",
      description: "Read-only access to reportTypes.list, jobs.list/get, and jobs.reports.list/get without activating write approvals.",
      inputSchema: z.object({
        resource: z.string().min(1),
        method: z.enum(["list", "get", "download"]),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
      annotations: readAnnotations,
    },
    handler((args: Parameters<ReportingService["read"]>[0]) => reporting.read(args)),
  );

  server.registerTool(
    "youtube_reporting_call",
    {
      title: "Call YouTube Reporting API",
      description: "Call reportTypes, jobs, or jobs.reports methods. Use resource paths such as reportTypes, jobs, or jobs.reports. Job creation requires APPLY; deletion requires DELETE.",
      inputSchema: z.object({
        resource: z.string().min(1),
        method: z.string().min(1),
        params: z.record(z.string(), z.unknown()).optional(),
        body: z.record(z.string(), z.unknown()).optional(),
        confirm: z.enum(["APPLY", "DELETE"]).optional(),
      }),
      annotations: writeAnnotations,
    },
    handler((args: Parameters<ReportingService["call"]>[0]) => reporting.call(args)),
  );

  server.registerTool(
    "youtube_reporting_download",
    {
      title: "Download YouTube bulk report",
      description: "Download a Reporting API CSV report to an allowed local path.",
      inputSchema: z.object({
        resourceName: z.string().min(1),
        outputPath: z.string().min(1),
        overwrite: z.boolean().default(false),
      }),
      annotations: localWriteAnnotations,
    },
    handler((args: Parameters<ReportingService["download"]>[0]) => reporting.download(args)),
  );

  return { server, store };
}

export async function serveStdio(): Promise<void> {
  const { server, store } = createServer();
  const transport = new StdioServerTransport();
  const cleanup = () => {
    try {
      store.close();
    } catch {
      // Process is already exiting.
    }
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  process.once("exit", cleanup);
  await server.connect(transport);
}
