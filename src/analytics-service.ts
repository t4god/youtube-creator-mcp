import type { YouTubeClient } from "./google.js";
import { completedDateRange } from "./utils.js";

export interface AnalyticsQuery {
  ids?: string;
  startDate: string;
  endDate: string;
  metrics: string;
  dimensions?: string;
  filters?: string;
  sort?: string;
  maxResults?: number;
  startIndex?: number;
  currency?: string;
  includeHistoricalChannelData?: boolean;
}

function normalizeReport(data: {
  columnHeaders?: Array<{ name?: string | null; dataType?: string | null; columnType?: string | null }> | null;
  rows?: unknown[][] | null;
  [key: string]: unknown;
}): Record<string, unknown> {
  const headers = data.columnHeaders ?? [];
  const names = headers.map((header) => header.name ?? "unknown");
  const rows = (data.rows ?? []).map((row) =>
    Object.fromEntries(names.map((name, index) => [name, row[index] ?? null])),
  );
  return { ...data, rows, rawRows: data.rows ?? [] };
}

export class AnalyticsService {
  constructor(private readonly client: YouTubeClient) {}

  async query(input: AnalyticsQuery): Promise<Record<string, unknown>> {
    const { analytics } = await this.client.context(true);
    const response = await this.client.executeRead("analytics.reports", "query", (options) =>
      analytics.reports.query({
        ids: input.ids ?? "channel==MINE",
        startDate: input.startDate,
        endDate: input.endDate,
        metrics: input.metrics,
        ...(input.dimensions ? { dimensions: input.dimensions } : {}),
        ...(input.filters ? { filters: input.filters } : {}),
        ...(input.sort ? { sort: input.sort } : {}),
        ...(input.maxResults ? { maxResults: input.maxResults } : {}),
        ...(input.startIndex ? { startIndex: input.startIndex } : {}),
        ...(input.currency ? { currency: input.currency } : {}),
        ...(input.includeHistoricalChannelData !== undefined
          ? { includeHistoricalChannelData: input.includeHistoricalChannelData }
          : {}),
      }, options), false,
    );
    return normalizeReport(response.data as Parameters<typeof normalizeReport>[0]);
  }

  async preset(input: {
    report:
      | "channel_overview"
      | "daily_trends"
      | "top_videos"
      | "traffic_sources"
      | "search_terms"
      | "geography"
      | "devices"
      | "demographics"
      | "retention";
    days?: number;
    startDate?: string;
    endDate?: string;
    videoId?: string;
    maxResults?: number;
    monetary?: boolean;
    currency?: string;
  }): Promise<Record<string, unknown>> {
    const range = input.startDate && input.endDate
      ? { startDate: input.startDate, endDate: input.endDate }
      : completedDateRange(input.days ?? 28);
    const common = { ...range, maxResults: input.maxResults ?? 50 };
    switch (input.report) {
      case "channel_overview":
        return this.query({
          ...common,
          metrics: [
            "views",
            "estimatedMinutesWatched",
            "averageViewDuration",
            "averageViewPercentage",
            "subscribersGained",
            "subscribersLost",
            "likes",
            "comments",
            "shares",
            ...(input.monetary ? ["estimatedRevenue", "estimatedAdRevenue", "grossRevenue"] : []),
          ].join(","),
          ...(input.currency ? { currency: input.currency } : {}),
        });
      case "daily_trends":
        return this.query({
          ...common,
          dimensions: "day",
          metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost",
          sort: "day",
          ...(input.videoId ? { filters: `video==${input.videoId}` } : {}),
        });
      case "top_videos":
        return this.query({
          ...common,
          dimensions: "video",
          metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares",
          sort: "-views",
        });
      case "traffic_sources":
        return this.query({
          ...common,
          dimensions: "insightTrafficSourceType",
          metrics: "views,estimatedMinutesWatched,averageViewDuration",
          sort: "-views",
          ...(input.videoId ? { filters: `video==${input.videoId}` } : {}),
        });
      case "search_terms":
        return this.query({
          ...common,
          dimensions: "insightTrafficSourceDetail",
          metrics: "views,estimatedMinutesWatched,averageViewDuration",
          filters: `insightTrafficSourceType==YT_SEARCH${input.videoId ? `;video==${input.videoId}` : ""}`,
          sort: "-views",
        });
      case "geography":
        return this.query({
          ...common,
          dimensions: "country",
          metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost",
          sort: "-views",
          ...(input.videoId ? { filters: `video==${input.videoId}` } : {}),
        });
      case "devices":
        return this.query({
          ...common,
          dimensions: "deviceType,operatingSystem",
          metrics: "views,estimatedMinutesWatched,averageViewDuration",
          sort: "-views",
          ...(input.videoId ? { filters: `video==${input.videoId}` } : {}),
        });
      case "demographics":
        return this.query({
          ...common,
          dimensions: "ageGroup,gender",
          metrics: "viewerPercentage",
          sort: "-viewerPercentage",
          ...(input.videoId ? { filters: `video==${input.videoId}` } : {}),
        });
      case "retention":
        if (!input.videoId) throw new Error("videoId is required for the retention preset.");
        return this.query({
          ...common,
          dimensions: "elapsedVideoTimeRatio",
          metrics: "audienceWatchRatio,relativeRetentionPerformance",
          filters: `video==${input.videoId}`,
          sort: "elapsedVideoTimeRatio",
        });
    }
  }
}
