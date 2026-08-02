import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { google } from "googleapis";
import type { AppConfig } from "./config.js";
import { assertWriteEnabled, resolveMediaPath } from "./config.js";
import { McpUserError } from "./errors.js";
import type { YouTubeClient } from "./google.js";

const READ_METHODS = new Set(["list", "get", "download"]);

function resolveResource(root: Record<string, unknown>, dottedPath: string): Record<string, unknown> | undefined {
  let current: unknown = root;
  for (const part of dottedPath.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current && typeof current === "object" ? (current as Record<string, unknown>) : undefined;
}

export class ReportingService {
  constructor(
    private readonly config: AppConfig,
    private readonly client: YouTubeClient,
  ) {}

  async call(input: {
    resource: string;
    method: string;
    params?: Record<string, unknown>;
    body?: Record<string, unknown>;
    confirm?: string;
  }): Promise<unknown> {
    const isRead = READ_METHODS.has(input.method);
    const destructive = input.method === "delete";
    if (!isRead) {
      assertWriteEnabled(this.config, destructive);
      const expected = destructive ? "DELETE" : "APPLY";
      if (input.confirm !== expected) {
        throw new McpUserError(`This operation requires confirm=\"${expected}\".`, "confirmation_required");
      }
    }
    const { reporting } = await this.client.context(true);
    const resource = resolveResource(reporting as unknown as Record<string, unknown>, input.resource);
    const method = resource?.[input.method];
    if (typeof method !== "function") {
      throw new McpUserError(
        `Unknown YouTube Reporting method: ${input.resource}.${input.method}`,
        "unknown_api_method",
      );
    }
    const params = { ...(input.params ?? {}), ...(input.body ? { requestBody: input.body } : {}) };
    const response = await (method as (params: Record<string, unknown>) => Promise<{ data: unknown }>).call(
      resource,
      params,
    );
    return response.data;
  }

  async read(input: {
    resource: string;
    method: string;
    params?: Record<string, unknown>;
  }): Promise<unknown> {
    if (!READ_METHODS.has(input.method)) {
      throw new McpUserError(
        `Method ${input.method} is not classified as read-only. Use youtube_reporting_call with the write guardrails.`,
        "write_method_not_allowed",
      );
    }
    return this.call(input);
  }

  async download(input: {
    resourceName: string;
    outputPath: string;
    overwrite?: boolean;
  }): Promise<Record<string, unknown>> {
    const outputPath = resolveMediaPath(this.config, input.outputPath, false);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(outputPath) && !input.overwrite) {
      throw new McpUserError(
        `Output file exists: ${outputPath}. Pass overwrite=true to replace it.`,
        "file_exists",
      );
    }
    const { reporting } = await this.client.context(true);
    const response = await reporting.media.download(
      { resourceName: input.resourceName },
      { responseType: "stream" },
    );
    await pipeline(response.data, fs.createWriteStream(outputPath, { flags: input.overwrite ? "w" : "wx", mode: 0o600 }));
    const stat = fs.statSync(outputPath);
    return { outputPath, bytes: stat.size };
  }

  async capabilities(): Promise<Record<string, string[]>> {
    const reporting = google.youtubereporting({ version: "v1" });
    const result: Record<string, string[]> = {};
    const visit = (value: unknown, prefix: string, depth: number) => {
      if (!value || typeof value !== "object" || depth > 2) return;
      const methods = [
        ...new Set([
          ...Object.keys(value as Record<string, unknown>),
          ...Object.getOwnPropertyNames(Object.getPrototypeOf(value) as object),
        ]),
      ].filter(
        (key) => key !== "constructor" && typeof (value as Record<string, unknown>)[key] === "function",
      );
      if (methods.length && prefix) result[prefix] = methods.sort();
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === "context") continue;
        if (child && typeof child === "object") visit(child, prefix ? `${prefix}.${key}` : key, depth + 1);
      }
    };
    visit(reporting, "", 0);
    return result;
  }
}
