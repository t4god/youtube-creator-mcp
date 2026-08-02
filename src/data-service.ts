import type { youtube_v3 } from "googleapis";
import type { YouTubeClient } from "./google.js";
import type { Store } from "./store.js";
import type { SnapshotVideo } from "./types.js";
import { chunks, numberOrNull, unique } from "./utils.js";

export class DataService {
  constructor(
    private readonly client: YouTubeClient,
    private readonly store: Store,
  ) {}

  async videos(videoIds: string[], parts = ["snippet", "contentDetails", "statistics", "status", "topicDetails"]): Promise<youtube_v3.Schema$Video[]> {
    const ids = unique(videoIds).filter(Boolean);
    const all: youtube_v3.Schema$Video[] = [];
    for (const batch of chunks(ids, 50)) {
      const { youtube } = await this.client.context(false);
      this.client.record("videos", "list");
      const response = await youtube.videos.list({ part: parts, id: batch });
      all.push(...(response.data.items ?? []));
    }
    return all;
  }

  async channels(channelIds: string[], parts = ["snippet", "statistics", "contentDetails", "brandingSettings", "topicDetails"]): Promise<youtube_v3.Schema$Channel[]> {
    const ids = unique(channelIds).filter(Boolean);
    const all: youtube_v3.Schema$Channel[] = [];
    for (const batch of chunks(ids, 50)) {
      const { youtube } = await this.client.context(false);
      this.client.record("channels", "list");
      const response = await youtube.channels.list({ part: parts, id: batch });
      all.push(...(response.data.items ?? []));
    }
    return all;
  }

  async myChannel(): Promise<youtube_v3.Schema$Channel | null> {
    const { youtube } = await this.client.context(true);
    this.client.record("channels", "list");
    const response = await youtube.channels.list({
      part: ["snippet", "statistics", "contentDetails", "brandingSettings", "status", "topicDetails"],
      mine: true,
    });
    return response.data.items?.[0] ?? null;
  }

  async channelUploads(input: {
    channelId?: string;
    mine?: boolean;
    maxResults?: number;
    pageToken?: string;
  }): Promise<Record<string, unknown>> {
    const { youtube } = await this.client.context(Boolean(input.mine));
    this.client.record("channels", "list");
    const channelResponse = await youtube.channels.list({
      part: ["snippet", "contentDetails"],
      ...(input.mine ? { mine: true } : { id: [input.channelId ?? ""] }),
    });
    const channel = channelResponse.data.items?.[0];
    const uploadsId = channel?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsId) return { channel: channel ?? null, items: [], nextPageToken: null };
    this.client.record("playlistItems", "list");
    const response = await youtube.playlistItems.list({
      part: ["snippet", "contentDetails", "status"],
      playlistId: uploadsId,
      maxResults: Math.min(input.maxResults ?? 50, 50),
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    });
    const videoIds = (response.data.items ?? [])
      .map((item) => item.contentDetails?.videoId)
      .filter((id): id is string => Boolean(id));
    const details = await this.videos(videoIds);
    const byId = new Map(details.map((item) => [item.id, item]));
    return {
      channel,
      uploadsPlaylistId: uploadsId,
      items: videoIds.map((id) => byId.get(id)).filter(Boolean),
      nextPageToken: response.data.nextPageToken ?? null,
      pageInfo: response.data.pageInfo ?? null,
    };
  }

  async comments(input: {
    videoId?: string;
    channelId?: string;
    allThreadsRelatedToChannelId?: string;
    maxResults?: number;
    pageToken?: string;
    order?: "time" | "relevance";
    searchTerms?: string;
    moderationStatus?: "heldForReview" | "likelySpam" | "published";
  }): Promise<unknown> {
    const { youtube } = await this.client.context(Boolean(input.moderationStatus));
    this.client.record("commentThreads", "list");
    const response = await youtube.commentThreads.list({
      part: ["snippet", "replies"],
      ...(input.videoId ? { videoId: input.videoId } : {}),
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.allThreadsRelatedToChannelId
        ? { allThreadsRelatedToChannelId: input.allThreadsRelatedToChannelId }
        : {}),
      maxResults: Math.min(input.maxResults ?? 100, 100),
      order: input.order ?? "relevance",
      textFormat: "plainText",
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
      ...(input.searchTerms ? { searchTerms: input.searchTerms } : {}),
      ...(input.moderationStatus ? { moderationStatus: input.moderationStatus } : {}),
    });
    return response.data;
  }

  async snapshot(videoIds: string[]): Promise<{ capturedAt: string; snapshots: SnapshotVideo[] }> {
    const capturedAt = new Date().toISOString();
    const items = await this.videos(videoIds);
    const snapshots = items.map<SnapshotVideo>((item) => ({
      videoId: item.id ?? "",
      channelId: item.snippet?.channelId ?? null,
      title: item.snippet?.title ?? null,
      publishedAt: item.snippet?.publishedAt ?? null,
      viewCount: numberOrNull(item.statistics?.viewCount),
      likeCount: numberOrNull(item.statistics?.likeCount),
      commentCount: numberOrNull(item.statistics?.commentCount),
      capturedAt,
    }));
    this.store.saveSnapshots(snapshots);
    return { capturedAt, snapshots };
  }

  history(videoIds: string[], limitPerVideo = 30): Array<SnapshotVideo & { deltas?: Record<string, number | null> }> {
    const history = this.store.snapshotHistory(videoIds, limitPerVideo);
    const grouped = new Map<string, SnapshotVideo[]>();
    for (const snapshot of history) {
      const values = grouped.get(snapshot.videoId) ?? [];
      values.push(snapshot);
      grouped.set(snapshot.videoId, values);
    }
    return history.map((snapshot) => {
      const positions = grouped.get(snapshot.videoId) ?? [];
      const index = positions.indexOf(snapshot);
      const older = positions[index + 1];
      if (!older) return snapshot;
      const hours = (Date.parse(snapshot.capturedAt) - Date.parse(older.capturedAt)) / 3_600_000;
      const viewDelta = snapshot.viewCount !== null && older.viewCount !== null ? snapshot.viewCount - older.viewCount : null;
      return {
        ...snapshot,
        deltas: {
          hours,
          views: viewDelta,
          viewsPerHour: viewDelta !== null && hours > 0 ? viewDelta / hours : null,
          likes:
            snapshot.likeCount !== null && older.likeCount !== null
              ? snapshot.likeCount - older.likeCount
              : null,
          comments:
            snapshot.commentCount !== null && older.commentCount !== null
              ? snapshot.commentCount - older.commentCount
              : null,
        },
      };
    });
  }
}
