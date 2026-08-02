import type { GaxiosError } from "gaxios";

export class McpUserError extends Error {
  constructor(
    message: string,
    public readonly code = "invalid_request",
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "McpUserError";
  }
}

export function normalizeError(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof McpUserError) {
    return { code: error.code, message: error.message, details: error.details };
  }

  const candidate = error as GaxiosError;
  if (candidate?.response) {
    const body = candidate.response.data as {
      error?: { code?: number; message?: string; errors?: unknown[]; status?: string };
    };
    const apiError = body?.error;
    return {
      code: apiError?.status ?? `http_${candidate.response.status}`,
      message: apiError?.message ?? candidate.message,
      details: apiError?.errors ?? body,
    };
  }

  if (error instanceof Error) {
    return { code: "internal_error", message: error.message };
  }
  return { code: "internal_error", message: String(error) };
}
