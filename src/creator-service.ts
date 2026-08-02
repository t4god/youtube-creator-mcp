import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { youtube_v3 } from "googleapis";
import type { AppConfig } from "./config.js";
import { assertPublicationEnabled, assertWriteEnabled, resolveMediaPath } from "./config.js";
import { McpUserError, normalizeError } from "./errors.js";
import type { YouTubeClient } from "./google.js";
import type { Store } from "./store.js";

export type PrivacyStatus = "private" | "unlisted" | "public";

export interface UploadInput {
  mediaPath: string;
  title: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  privacyStatus?: PrivacyStatus;
  publishAt?: string;
  selfDeclaredMadeForKids?: boolean;
  containsSyntheticMedia?: boolean;
  notifySubscribers?: boolean;
  operationId: string;
  confirm?: "APPLY" | "PUBLISH";
}

export interface UpdateVideoInput {
  videoId: string;
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  privacyStatus?: PrivacyStatus;
  publishAt?: string | null;
  selfDeclaredMadeForKids?: boolean;
  containsSyntheticMedia?: boolean;
  confirm?: "APPLY" | "PUBLISH";
}

const VIDEO_MIME = new Map([
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".m4v", "video/x-m4v"],
  [".webm", "video/webm"],
  [".avi", "video/x-msvideo"],
  [".mkv", "video/x-matroska"],
]);

const THUMBNAIL_MIME = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
]);

function requireConfirmation(actual: string | undefined, expected: "APPLY" | "PUBLISH"): void {
  if (actual !== expected) {
    throw new McpUserError(`This operation requires confirm=\"${expected}\".`, "confirmation_required");
  }
}

function validateTitle(title: string): void {
  if (!title.trim() || [...title].length > 100 || /[<>]/.test(title)) {
    throw new McpUserError(
      "title must contain 1-100 characters and cannot contain < or >.",
      "invalid_video_metadata",
    );
  }
}

function validateDescription(description: string | undefined): void {
  if (description !== undefined && [...description].length > 5_000) {
    throw new McpUserError("description cannot exceed 5,000 characters.", "invalid_video_metadata");
  }
}

function validateTags(tags: string[] | undefined): void {
  if (!tags) return;
  if (tags.some((tag) => !tag.trim())) {
    throw new McpUserError("tags cannot contain blank values.", "invalid_video_metadata");
  }
  const serializedLength = tags.map((tag) => (tag.includes(" ") ? `\"${tag}\"` : tag)).join(",").length;
  if (serializedLength > 500) {
    throw new McpUserError("The serialized tags value cannot exceed 500 characters.", "invalid_video_metadata");
  }
}

function validateCategory(categoryId: string | undefined): void {
  if (categoryId !== undefined && !/^\d+$/.test(categoryId)) {
    throw new McpUserError("categoryId must be a numeric YouTube video category ID.", "invalid_video_metadata");
  }
}

function validateSchedule(publishAt: string | null | undefined, privacyStatus?: PrivacyStatus): void {
  if (!publishAt) return;
  const timestamp = Date.parse(publishAt);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new McpUserError("publishAt must be a valid future date-time.", "invalid_publish_schedule");
  }
  if (privacyStatus && privacyStatus !== "private") {
    throw new McpUserError("Scheduled videos must use privacyStatus=private.", "invalid_publish_schedule");
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function publicationRequested(input: { privacyStatus?: PrivacyStatus; publishAt?: string | null }): boolean {
  return input.privacyStatus === "public" || input.privacyStatus === "unlisted" || Boolean(input.publishAt);
}

export class CreatorService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly client: YouTubeClient,
  ) {}

  async uploadPlan(input: UploadInput): Promise<Record<string, unknown>> {
    validateTitle(input.title);
    validateDescription(input.description);
    validateTags(input.tags);
    validateCategory(input.categoryId);
    validateSchedule(input.publishAt, input.privacyStatus);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.operationId)) {
      throw new McpUserError(
        "operationId must be 8-128 characters using letters, numbers, dot, underscore, colon, or hyphen.",
        "invalid_operation_id",
      );
    }
    const mediaPath = resolveMediaPath(this.config, input.mediaPath, true);
    const stat = fs.statSync(mediaPath);
    if (!stat.isFile() || stat.size === 0) {
      throw new McpUserError("mediaPath must be a non-empty regular file.", "invalid_media_file");
    }
    const mimeType = VIDEO_MIME.get(path.extname(mediaPath).toLowerCase());
    if (!mimeType) {
      throw new McpUserError(
        `Unsupported video extension. Supported: ${[...VIDEO_MIME.keys()].join(", ")}.`,
        "unsupported_media_type",
      );
    }
    const contentSha256 = await sha256File(mediaPath);
    const privacyStatus = input.publishAt ? "private" : (input.privacyStatus ?? "private");
    const metadata = {
      title: input.title,
      description: input.description ?? "",
      tags: input.tags ?? [],
      categoryId: input.categoryId ?? "22",
      privacyStatus,
      publishAt: input.publishAt ?? null,
      selfDeclaredMadeForKids: input.selfDeclaredMadeForKids ?? null,
      containsSyntheticMedia: input.containsSyntheticMedia ?? null,
      notifySubscribers: input.notifySubscribers ?? true,
    };
    const fingerprint = crypto
      .createHash("sha256")
      .update(contentSha256)
      .update("\0")
      .update(JSON.stringify(metadata))
      .digest("hex");
    const previousOperation = this.store.getUploadOperation(input.operationId);
    return {
      operationId: input.operationId,
      media: { path: mediaPath, bytes: stat.size, mimeType, contentSha256 },
      metadata,
      fingerprint,
      previousOperation,
      publicationRequested: publicationRequested(input),
      requiredConfirmation: publicationRequested(input) ? "PUBLISH" : "APPLY",
      requiredServerFlags: publicationRequested(input)
        ? ["YOUTUBE_MCP_ENABLE_WRITES=true", "YOUTUBE_MCP_ENABLE_PUBLICATION=true"]
        : ["YOUTUBE_MCP_ENABLE_WRITES=true"],
      warnings: [
        "Unverified API projects created after 2020 may have API uploads locked to private visibility.",
        "A crash after YouTube accepts an upload but before local completion is recorded requires manual Studio verification.",
      ],
    };
  }

  async upload(input: UploadInput): Promise<Record<string, unknown>> {
    const plan = await this.uploadPlan(input);
    const publish = publicationRequested(input);
    if (publish) assertPublicationEnabled(this.config);
    else assertWriteEnabled(this.config);
    requireConfirmation(input.confirm, publish ? "PUBLISH" : "APPLY");

    const fingerprint = String(plan["fingerprint"]);
    const started = this.store.beginUploadOperation(input.operationId, fingerprint);
    if (!started.created) {
      if (started.operation.fingerprint !== fingerprint) {
        throw new McpUserError(
          "operationId was already used for a different file or metadata payload.",
          "operation_id_conflict",
          { existing: started.operation },
        );
      }
      if (started.operation.state === "completed") {
        this.store.recordWriteAudit({
          operation: "videos.insert",
          target: started.operation.videoId ?? undefined,
          confirmation: input.confirm ?? "",
          outcome: "deduplicated",
          details: { operationId: input.operationId },
        });
        return { deduplicated: true, operation: started.operation };
      }
      throw new McpUserError(
        `This operationId is ${started.operation.state}. Verify YouTube Studio before using a new operationId; automatic retry is intentionally blocked to prevent duplicate uploads.`,
        "upload_retry_blocked",
        { operation: started.operation },
      );
    }

    const media = plan["media"] as { path: string; mimeType: string };
    const metadata = plan["metadata"] as Record<string, unknown>;
    this.store.recordWriteAudit({
      operation: "videos.insert",
      confirmation: input.confirm ?? "",
      outcome: "started",
      details: { operationId: input.operationId, fingerprint },
    });
    try {
      const { youtube } = await this.client.context(true);
      const response = await this.client.executeWrite("videos", "insert", (options) =>
        youtube.videos.insert({
          part: ["snippet", "status"],
          notifySubscribers: metadata["notifySubscribers"] as boolean,
          requestBody: {
            snippet: {
              title: metadata["title"] as string,
              description: metadata["description"] as string,
              tags: metadata["tags"] as string[],
              categoryId: metadata["categoryId"] as string,
            },
            status: {
              privacyStatus: metadata["privacyStatus"] as string,
              ...(metadata["publishAt"] ? { publishAt: metadata["publishAt"] as string } : {}),
              ...(metadata["selfDeclaredMadeForKids"] !== null
                ? { selfDeclaredMadeForKids: metadata["selfDeclaredMadeForKids"] as boolean }
                : {}),
              ...(metadata["containsSyntheticMedia"] !== null
                ? { containsSyntheticMedia: metadata["containsSyntheticMedia"] as boolean }
                : {}),
            },
          },
          media: { body: fs.createReadStream(media.path), mimeType: media.mimeType },
        }, options),
      );
      const videoId = response.data.id ?? "";
      this.store.completeUploadOperation(input.operationId, videoId, response.data);
      this.store.recordWriteAudit({
        operation: "videos.insert",
        target: videoId,
        confirmation: input.confirm ?? "",
        outcome: "succeeded",
        details: { operationId: input.operationId, fingerprint },
      });
      return { deduplicated: false, operationId: input.operationId, video: response.data };
    } catch (error) {
      const normalized = normalizeError(error);
      this.store.failUploadOperation(input.operationId, normalized);
      this.store.recordWriteAudit({
        operation: "videos.insert",
        confirmation: input.confirm ?? "",
        outcome: "failed",
        details: { operationId: input.operationId, error: normalized },
      });
      throw error;
    }
  }

  async updateVideo(input: UpdateVideoInput): Promise<youtube_v3.Schema$Video> {
    if (!input.videoId.trim()) throw new McpUserError("videoId is required.", "invalid_video_id");
    if (input.title !== undefined) validateTitle(input.title);
    validateDescription(input.description);
    validateTags(input.tags);
    validateCategory(input.categoryId);
    validateSchedule(input.publishAt, input.privacyStatus);
    const snippetChanged = [input.title, input.description, input.tags, input.categoryId].some((value) => value !== undefined);
    const statusChanged = [
      input.privacyStatus,
      input.publishAt,
      input.selfDeclaredMadeForKids,
      input.containsSyntheticMedia,
    ].some((value) => value !== undefined);
    if (!snippetChanged && !statusChanged) {
      throw new McpUserError("Provide at least one metadata or status change.", "no_changes");
    }
    const publish = publicationRequested(input);
    if (publish) assertPublicationEnabled(this.config);
    else assertWriteEnabled(this.config);
    requireConfirmation(input.confirm, publish ? "PUBLISH" : "APPLY");

    const { youtube } = await this.client.context(true);
    const currentResponse = await this.client.executeRead("videos", "list", (options) =>
      youtube.videos.list({ part: ["snippet", "status"], id: [input.videoId] }, options),
    );
    const current = currentResponse.data.items?.[0];
    if (!current) throw new McpUserError("Video not found or not accessible.", "video_not_found");
    const parts: string[] = [];
    const requestBody: youtube_v3.Schema$Video = { id: input.videoId };
    if (snippetChanged) {
      parts.push("snippet");
      requestBody.snippet = {
        title: current.snippet?.title,
        description: current.snippet?.description,
        tags: current.snippet?.tags,
        categoryId: current.snippet?.categoryId,
        defaultLanguage: current.snippet?.defaultLanguage,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      };
    }
    if (statusChanged) {
      parts.push("status");
      requestBody.status = {
        privacyStatus: current.status?.privacyStatus,
        license: current.status?.license,
        embeddable: current.status?.embeddable,
        publicStatsViewable: current.status?.publicStatsViewable,
        selfDeclaredMadeForKids: current.status?.selfDeclaredMadeForKids,
        containsSyntheticMedia: current.status?.containsSyntheticMedia,
        ...(input.publishAt ? { privacyStatus: "private" } : {}),
        ...(input.privacyStatus !== undefined ? { privacyStatus: input.privacyStatus } : {}),
        ...(input.publishAt !== undefined ? { publishAt: input.publishAt } : {}),
        ...(input.selfDeclaredMadeForKids !== undefined
          ? { selfDeclaredMadeForKids: input.selfDeclaredMadeForKids }
          : {}),
        ...(input.containsSyntheticMedia !== undefined
          ? { containsSyntheticMedia: input.containsSyntheticMedia }
          : {}),
      };
    }
    this.store.recordWriteAudit({
      operation: "videos.update",
      target: input.videoId,
      confirmation: input.confirm ?? "",
      outcome: "started",
      details: { parts },
    });
    try {
      const response = await this.client.executeWrite("videos", "update", (options) =>
        youtube.videos.update({ part: parts, requestBody }, options),
      );
      this.store.recordWriteAudit({
        operation: "videos.update",
        target: input.videoId,
        confirmation: input.confirm ?? "",
        outcome: "succeeded",
        details: { parts },
      });
      return response.data;
    } catch (error) {
      this.store.recordWriteAudit({
        operation: "videos.update",
        target: input.videoId,
        confirmation: input.confirm ?? "",
        outcome: "failed",
        details: normalizeError(error),
      });
      throw error;
    }
  }

  async setThumbnail(input: {
    videoId: string;
    imagePath: string;
    confirm?: "APPLY";
  }): Promise<unknown> {
    assertWriteEnabled(this.config);
    requireConfirmation(input.confirm, "APPLY");
    const imagePath = resolveMediaPath(this.config, input.imagePath, true);
    const stat = fs.statSync(imagePath);
    const mimeType = THUMBNAIL_MIME.get(path.extname(imagePath).toLowerCase());
    if (!mimeType || !stat.isFile() || stat.size === 0 || stat.size > 2_000_000) {
      throw new McpUserError(
        "Thumbnail must be a non-empty JPEG or PNG file no larger than 2 MB.",
        "invalid_thumbnail",
      );
    }
    const { youtube } = await this.client.context(true);
    this.store.recordWriteAudit({
      operation: "thumbnails.set",
      target: input.videoId,
      confirmation: input.confirm ?? "",
      outcome: "started",
      details: { bytes: stat.size },
    });
    try {
      const response = await this.client.executeWrite("thumbnails", "set", (options) =>
        youtube.thumbnails.set({
          videoId: input.videoId,
          media: { body: fs.createReadStream(imagePath), mimeType },
        }, options),
      );
      this.store.recordWriteAudit({
        operation: "thumbnails.set",
        target: input.videoId,
        confirmation: input.confirm ?? "",
        outcome: "succeeded",
      });
      return response.data;
    } catch (error) {
      this.store.recordWriteAudit({
        operation: "thumbnails.set",
        target: input.videoId,
        confirmation: input.confirm ?? "",
        outcome: "failed",
        details: normalizeError(error),
      });
      throw error;
    }
  }

  async uploadStatus(videoId: string): Promise<youtube_v3.Schema$Video | null> {
    const { youtube } = await this.client.context(true);
    const response = await this.client.executeRead("videos", "list", (options) =>
      youtube.videos.list({ part: ["snippet", "status", "processingDetails", "fileDetails"], id: [videoId] }, options),
    );
    return response.data.items?.[0] ?? null;
  }
}
