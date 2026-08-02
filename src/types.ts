export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ToolEnvelope<T = unknown> {
  ok: true;
  data: T;
  meta?: Record<string, JsonValue>;
}

export interface ToolFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: JsonValue;
  };
}

export interface SnapshotVideo {
  videoId: string;
  channelId: string | null;
  title: string | null;
  publishedAt: string | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  capturedAt: string;
}

export interface TopicVideo {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  views: number;
  likes: number;
  comments: number;
  channelSubscribers: number | null;
  ageDays: number;
  viewsPerDay: number;
  viewSubscriberRatio: number | null;
  url: string;
}
