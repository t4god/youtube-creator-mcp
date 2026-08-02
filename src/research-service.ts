import type { youtube_v3 } from "googleapis";
import type { AppConfig } from "./config.js";
import type { DataService } from "./data-service.js";
import type { YouTubeClient } from "./google.js";
import type { Store } from "./store.js";
import type { TopicVideo } from "./types.js";
import { numberOrNull, percentile, stableKey, unique } from "./utils.js";

export interface TopicResearchInput {
  query: string;
  days?: number;
  maxResults?: number;
  order?: "date" | "rating" | "relevance" | "title" | "videoCount" | "viewCount";
  regionCode?: string;
  relevanceLanguage?: string;
  videoDuration?: "any" | "long" | "medium" | "short";
  publishedAfter?: string;
  publishedBefore?: string;
  forceRefresh?: boolean;
}

interface TopicResearchResult {
  query: string;
  sample: TopicVideo[];
  summary: Record<string, unknown>;
  methodology: Record<string, unknown>;
}

function summarize(query: string, sample: TopicVideo[]): TopicResearchResult {
  const views = sample.map((item) => item.views);
  const velocities = sample.map((item) => item.viewsPerDay);
  const ratios = sample
    .map((item) => item.viewSubscriberRatio)
    .filter((value): value is number => value !== null);
  const uniqueChannels = unique(sample.map((item) => item.channelId)).length;
  const medianViews = percentile(views, 0.5);
  const p90Views = percentile(views, 0.9);
  const medianVelocity = percentile(velocities, 0.5);
  const breakoutThreshold = Math.max(1, percentile(ratios, 0.75));
  const breakouts = sample.filter(
    (item) => item.viewSubscriberRatio !== null && item.viewSubscriberRatio >= breakoutThreshold,
  );
  return {
    query,
    sample: [...sample].sort((a, b) => b.viewsPerDay - a.viewsPerDay),
    summary: {
      sampleSize: sample.length,
      uniqueChannels,
      channelConcentration: sample.length ? 1 - uniqueChannels / sample.length : 0,
      medianViews,
      p90Views,
      medianViewsPerDay: medianVelocity,
      p90ViewsPerDay: percentile(velocities, 0.9),
      medianViewSubscriberRatio: percentile(ratios, 0.5),
      breakoutCount: breakouts.length,
      breakoutExamples: breakouts
        .sort((a, b) => (b.viewSubscriberRatio ?? 0) - (a.viewSubscriberRatio ?? 0))
        .slice(0, 5),
      newestPublishedAt: sample.map((item) => item.publishedAt).sort().at(-1) ?? null,
      oldestPublishedAt: sample.map((item) => item.publishedAt).sort().at(0) ?? null,
    },
    methodology: {
      source: "YouTube Data API search.list followed by batched videos.list and channels.list",
      caveats: [
        "A search result sample is not exhaustive and is affected by the selected order, locale, and date window.",
        "Current statistics are snapshots; views-per-day is a lifetime average unless repeated snapshots are collected.",
        "Hidden subscriber counts produce null view/subscriber ratios.",
      ],
    },
  };
}

export class ResearchService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly client: YouTubeClient,
    private readonly data: DataService,
  ) {}

  async topic(input: TopicResearchInput): Promise<TopicResearchResult & { cached: boolean }> {
    const normalized = {
      ...input,
      days: input.days ?? 90,
      maxResults: Math.min(input.maxResults ?? 25, 50),
      order: input.order ?? "relevance",
    };
    const cacheKey = stableKey("topic", normalized);
    if (!input.forceRefresh) {
      const cached = this.store.getCache<TopicResearchResult>(cacheKey);
      if (cached) return { ...cached, cached: true };
    }
    const publishedAfter = input.publishedAfter ?? (() => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - normalized.days);
      return date.toISOString();
    })();
    const { youtube } = await this.client.context(false);
    this.client.record("search", "list");
    const search = await youtube.search.list({
      part: ["snippet"],
      q: input.query,
      type: ["video"],
      maxResults: normalized.maxResults,
      order: normalized.order,
      publishedAfter,
      ...(input.publishedBefore ? { publishedBefore: input.publishedBefore } : {}),
      ...(input.regionCode ? { regionCode: input.regionCode } : {}),
      ...(input.relevanceLanguage ? { relevanceLanguage: input.relevanceLanguage } : {}),
      ...(input.videoDuration ? { videoDuration: input.videoDuration } : {}),
    });
    const videoIds = (search.data.items ?? [])
      .map((item) => item.id?.videoId)
      .filter((id): id is string => Boolean(id));
    const videos = await this.data.videos(videoIds);
    const channelIds = videos
      .map((video) => video.snippet?.channelId)
      .filter((id): id is string => Boolean(id));
    const channels = await this.data.channels(channelIds, ["snippet", "statistics"]);
    const channelMap = new Map(channels.map((channel) => [channel.id, channel]));
    const now = Date.now();
    const sample = videos.map<TopicVideo>((video: youtube_v3.Schema$Video) => {
      const publishedAt = video.snippet?.publishedAt ?? new Date(now).toISOString();
      const ageDays = Math.max(1 / 24, (now - Date.parse(publishedAt)) / 86_400_000);
      const views = numberOrNull(video.statistics?.viewCount) ?? 0;
      const channel = channelMap.get(video.snippet?.channelId ?? "");
      const hidden = channel?.statistics?.hiddenSubscriberCount ?? false;
      const subscribers = hidden ? null : numberOrNull(channel?.statistics?.subscriberCount);
      return {
        videoId: video.id ?? "",
        title: video.snippet?.title ?? "",
        channelId: video.snippet?.channelId ?? "",
        channelTitle: video.snippet?.channelTitle ?? "",
        publishedAt,
        views,
        likes: numberOrNull(video.statistics?.likeCount) ?? 0,
        comments: numberOrNull(video.statistics?.commentCount) ?? 0,
        channelSubscribers: subscribers,
        ageDays,
        viewsPerDay: views / ageDays,
        viewSubscriberRatio: subscribers && subscribers > 0 ? views / subscribers : null,
        url: `https://www.youtube.com/watch?v=${video.id ?? ""}`,
      };
    });
    const result = summarize(input.query, sample);
    this.store.setCache(cacheKey, result, this.config.cacheTtlSeconds);
    return { ...result, cached: false };
  }

  async compare(inputs: TopicResearchInput[]): Promise<Record<string, unknown>> {
    const results: Array<TopicResearchResult & { cached: boolean }> = [];
    for (const input of inputs) results.push(await this.topic(input));
    const ranked = results
      .map((result) => ({ query: result.query, ...result.summary }))
      .sort(
        (a, b) =>
          Number((b as Record<string, unknown>)["medianViewsPerDay"] ?? 0) -
          Number((a as Record<string, unknown>)["medianViewsPerDay"] ?? 0),
      );
    return {
      rankingBasis: "medianViewsPerDay in each API search sample",
      ranked,
      topics: results,
    };
  }
}
