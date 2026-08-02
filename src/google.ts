import fs from "node:fs";
import { google, type youtube_v3 } from "googleapis";
import type { GaxiosError } from "gaxios";
import type { AppConfig } from "./config.js";
import { assertPublicationEnabled, assertWriteEnabled, resolveMediaPath } from "./config.js";
import { getOAuthClient } from "./auth.js";
import { McpUserError, normalizeError } from "./errors.js";
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
  if (resource === "search" && method === "list") return { bucket: "search", cost: 100 };
  if (resource === "videos" && method === "insert") return { bucket: "upload", cost: 100 };
  return { bucket: "data", cost: DATA_COSTS[`${resource}.${method}`] ?? 1 };
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface RequestOptions {
  signal: AbortSignal;
  retry: boolean;
}

export interface WriteOptions {
  retry: false;
}

export function retryableReadError(error: unknown): boolean {
  const candidate = error as GaxiosError;
  if (candidate?.response?.status && RETRYABLE_STATUS.has(candidate.response.status)) return true;
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN";
}

export function retryDelayMs(attempt: number, baseDelayMs: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 60_000);
  }
  const exponential = Math.min(baseDelayMs * 2 ** attempt, 30_000);
  return Math.round(exponential * (0.8 + Math.random() * 0.4));
}

function requiresPublicationGate(input: {
  resource: string;
  method: string;
  body?: Record<string, unknown>;
}): boolean {
  if (input.resource === "liveBroadcasts" && ["insert", "update", "bind", "transition"].includes(input.method)) {
    return true;
  }
  if (input.resource !== "videos" || !["insert", "update"].includes(input.method)) return false;
  const status = input.body?.["status"] as Record<string, unknown> | undefined;
  const privacy = status?.["privacyStatus"];
  if (status?.["publishAt"]) return true;
  if (input.method === "insert") return privacy !== "private";
  return privacy === "public" || privacy === "unlisted";
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

  async executeRead<T>(
    resource: string,
    method: string,
    call: (options: RequestOptions) => Promise<T>,
    trackQuota = true,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      if (trackQuota) this.record(resource, method);
      try {
        return await call({ signal: AbortSignal.timeout(this.config.requestTimeoutMs), retry: false });
      } catch (error) {
        if (attempt >= this.config.maxReadRetries || !retryableReadError(error)) throw error;
        const headers = (error as GaxiosError)?.response?.headers as
          | (Record<string, string> & { get?: (name: string) => string | null })
          | undefined;
        const retryAfter = headers?.get?.("retry-after") ?? headers?.["retry-after"];
        const delay = retryDelayMs(attempt, this.config.retryBaseDelayMs, retryAfter);
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt += 1;
      }
    }
  }

  async executeWrite<T>(
    resource: string,
    method: string,
    call: (options: WriteOptions) => Promise<T>,
    trackQuota = true,
  ): Promise<T> {
    if (trackQuota) this.record(resource, method);
    return call({ retry: false });
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
    if (!isRead && (
      (input.resource === "videos" && input.method === "insert") ||
      (input.resource === "thumbnails" && input.method === "set")
    )) {
      throw new McpUserError(
        `Use the typed ${input.resource === "videos" ? "youtube_upload_video" : "youtube_set_thumbnail"} tool for this media write.`,
        "typed_tool_required",
      );
    }
    const requestBody = input.body ?? (input.params?.["requestBody"] as Record<string, unknown> | undefined);
    const publication = !isRead && requiresPublicationGate({
      resource: input.resource,
      method: input.method,
      ...(requestBody ? { body: requestBody } : {}),
    });
    if (!isRead) {
      if (publication) assertPublicationEnabled(this.config);
      else assertWriteEnabled(this.config, destructive);
      const expected = destructive ? "DELETE" : publication ? "PUBLISH" : "APPLY";
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
    if (isRead) {
      const response = await this.executeRead(input.resource, input.method, (options) =>
        (method as (params: Record<string, unknown>, options: RequestOptions) => Promise<{ data: unknown }>).call(
          resource,
          params,
          options,
        ),
      );
      return response.data;
    }
    this.store.recordWriteAudit({
      operation: `${input.resource}.${input.method}`,
      confirmation: input.confirm ?? "",
      outcome: "started",
    });
    try {
      const response = await this.executeWrite(input.resource, input.method, (options) =>
        (method as (params: Record<string, unknown>, options: WriteOptions) => Promise<{ data: unknown }>).call(
          resource,
          params,
          options,
        ),
      );
      this.store.recordWriteAudit({
        operation: `${input.resource}.${input.method}`,
        confirmation: input.confirm ?? "",
        outcome: "succeeded",
      });
      return response.data;
    } catch (error) {
      this.store.recordWriteAudit({
        operation: `${input.resource}.${input.method}`,
        confirmation: input.confirm ?? "",
        outcome: "failed",
        details: normalizeError(error),
      });
      throw error;
    }
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
      if (resourceName === "context") continue;
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
