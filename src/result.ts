import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { normalizeError } from "./errors.js";

export function toolResult(data: unknown, meta?: Record<string, unknown>): CallToolResult {
  const structuredContent = { ok: true, data, ...(meta ? { meta } : {}) };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

export function toolError(error: unknown): CallToolResult {
  const normalized = normalizeError(error);
  const structuredContent = { ok: false, error: normalized };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

export function wrapTool<TArgs extends Record<string, unknown>>(
  handler: (args: TArgs) => Promise<CallToolResult>,
): (args: TArgs) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      return toolError(error);
    }
  };
}
