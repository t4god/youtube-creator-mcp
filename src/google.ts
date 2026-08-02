import fs from "node:fs";
import { google, type youtube_v3 } from "googleapis";
import type { AppConfig } from "./config.js";
import { assertWriteEnabled, resolveMediaPath } from "./config.js";
import { getOAuthClient } from "./auth.js";
import { McpUserError } from "./errors.js";
import type { Store } from "./store.js";

export interface ApiContext {
  youtube: youtube_v3.Youtube;
  analytics: ReturnType<typeof google.youtubeAnalytics>;
  reporting: ReturnType<typeof google.youtubereporting>;
  authMode: "oauth" | "api_key";
}

const DATA_COSTS: Record<string, number> = {
  "captions.list": 50,
  "captions.insert": 400,
  "captions.update": 450,
  "captions.delete": 50,
  "channelBanners.insert": 50,
  "channels.update": 50,
  "channelSections.insert": 50,
  "channelSections.update": 50,
  "channelSections.delete": 50,
  "comments.insert": 50,
  "comments.update": 50,
  "comments.setModerationStatus": 50,
  "comments.delete": 50,
  "commentThreads.insert": 50,
  "commentThreads.update": 50,
  "playlistItems.insert": 50,
  "playlistItems.update": 50,
  "playlistItems.delete": 50,
  "playlists.insert": 50,
  "playlists.update": 50,
  "playlists.delete": 50,
  "subscriptions.insert": 50,
  "subscriptions.delete": 50,
  "thumbnails.set": 50,
  "videos.update": 50,
  "videos.rate": 50,
  "videos.reportAbuse": 50,
  "videos.delete": 50,
  "watermarks.set": 50,
  "watermarks.unset": 50,
};

const READ_METHODS = new Set(["list", "get", "getRating", "download", "streamList"]);
const DESTRUCTIVE_METHODS = new Set(["delete", "unset", "reportAbuse"]);

export function operationCost(resource: string, method: string): {
  bucket: "data" | "search" | "upload";
  cost: number;
} {
  if (resource === "search" && method === "list") return { bucket: "search", cost: 1 };
  if (resource === "videos" && method === "insert") return { bucket: "upload", cost: 1 };
  return { bucket: "data", cost: DATA_COSTS[`${resource}.${method}`] ?? 1 };
}

export class YouTubeClient {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
  ) {}

  async context(requireOAuth = false): Promise<ApiContext> {
    const oauth = await getOAuthClient(false);
    if (oauth) {
      return {
        youtube: google.youtube({ version: "v3", auth: oauth.auth }),
        analytics: google.youtubeAnalytics({ version: "v2", auth: oauth.auth }),
        reporting: google.youtubereporting({ version: "v1", auth: oauth.auth }),
        authMode: "oauth",
      };
    }
    if (requireOAuth || !this.config.apiKey) {
      throw new McpUserError(
        "OAuth is required for this operation. Run the YouTube MCP auth command first.",
        "oauth_required",
      );
    }
    return {
      youtube: google.youtube({ version: "v3", auth: this.config.apiKey }),
      analytics: google.youtubeAnalytics({ version: "v2", auth: this.config.apiKey }),
      reporting: google.youtubereporting({ version: "v1", auth: this.config.apiKey }),
      authMode: "api_key",
    };
  }

  record(resource: string, method: string): void {
    const { bucket, cost } = operationCost(resource, method);
    this.store.recordQuota(`${resource}.${method}`, bucket, cost);
  }

  async dataCall(input: {
    resource: string;
    method: string;
    params?: Record<string, unknown>;
    body?: Record<string, unknown>;
    mediaPath?: string;
    confirm?: string;
  }): Promise<unknown> {
    const isRead = READ_METHODS.has(input.method);
    const destructive = DESTRUCTIVE_METHODS.has(input.method);
    if (!isRead) {
      assertWriteEnabled(this.config, destructive);
      const expected = destructive ? "DELETE" : "APPLY";
      if (input.confirm !== expected) {
        throw new McpUserError(
          `This operation requires confirm=\"${expected}\".`,
          "confirmation_required",
        );
      }
    }
    const context = await this.context(!isRead);
    const resource = (context.youtube as unknown as Record<string, unknown>)[input.resource] as
      | Record<string, unknown>
      | undefined;
    const method = resource?.[input.method];
    if (typeof method !== "function") {
      throw new McpUserError(
        `Unknown YouTube Data/Live method: ${input.resource}.${input.method}`,
        "unknown_api_method",
      );
    }
    const params: Record<string, unknown> = { ...(input.params ?? {}) };
    if (input.body) params.requestBody = input.body;
    if (input.mediaPath) {
      const resolved = resolveMediaPath(this.config, input.mediaPath, true);
      params.media = { body: fs.createReadStream(resolved) };
    }
    this.record(input.resource, input.method);
    const response = await (method as (params: Record<string, unknown>) => Promise<{ data: unknown }>).call(
      resource,
      params,
    );
    return response.data;
  }

  async dataRead(input: {
    resource: string;
    method: string;
    params?: Record<string, unknown>;
  }): Promise<unknown> {
    if (!READ_METHODS.has(input.method)) {
      throw new McpUserError(
        `Method ${input.method} is not classified as read-only. Use youtube_data_call with the write guardrails.`,
        "write_method_not_allowed",
      );
    }
    return this.dataCall(input);
  }

  async capabilities(): Promise<Record<string, string[]>> {
    const youtube = google.youtube({ version: "v3" });
    const result: Record<string, string[]> = {};
    for (const [resourceName, resource] of Object.entries(youtube as unknown as Record<string, unknown>)) {
      if (!resource || typeof resource !== "object") continue;
      const methods = [
        ...new Set([
          ...Object.keys(resource as Record<string, unknown>),
          ...Object.getOwnPropertyNames(Object.getPrototypeOf(resource) as object),
        ]),
      ].filter(
        (key) => key !== "constructor" && typeof (resource as Record<string, unknown>)[key] === "function",
      );
      if (methods.length) result[resourceName] = methods.sort();
    }
    return result;
  }
}
