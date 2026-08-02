import { DatabaseSync } from "node:sqlite";
import type { SnapshotVideo } from "./types.js";

export interface QuotaSummary {
  date: string;
  dataUnits: number;
  searchCalls: number;
  uploadCalls: number;
  calls: number;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quota_events (
        id INTEGER PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        bucket TEXT NOT NULL,
        cost INTEGER NOT NULL,
        operation TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS quota_events_time_idx ON quota_events(occurred_at);

      CREATE TABLE IF NOT EXISTS video_snapshots (
        video_id TEXT NOT NULL,
        channel_id TEXT,
        title TEXT,
        published_at TEXT,
        view_count INTEGER,
        like_count INTEGER,
        comment_count INTEGER,
        captured_at TEXT NOT NULL,
        PRIMARY KEY(video_id, captured_at)
      );
      CREATE INDEX IF NOT EXISTS video_snapshots_video_idx
        ON video_snapshots(video_id, captured_at DESC);

      CREATE TABLE IF NOT EXISTS cache (
        cache_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  recordQuota(operation: string, bucket: "data" | "search" | "upload", cost: number): void {
    this.db
      .prepare("INSERT INTO quota_events(occurred_at, bucket, cost, operation) VALUES(?, ?, ?, ?)")
      .run(new Date().toISOString(), bucket, cost, operation);
  }

  quotaToday(now = new Date()): QuotaSummary {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const date = formatter.format(now);
    const rows = this.db
      .prepare(
        `SELECT occurred_at, bucket, cost
         FROM quota_events WHERE occurred_at >= ?`,
      )
      .all(new Date(now.getTime() - 36 * 3_600_000).toISOString()) as Array<{
        occurred_at: string;
        bucket: string;
        cost: number;
      }>;
    const summary: QuotaSummary = { date, dataUnits: 0, searchCalls: 0, uploadCalls: 0, calls: 0 };
    for (const row of rows) {
      if (formatter.format(new Date(row.occurred_at)) !== date) continue;
      summary.calls += 1;
      if (row.bucket === "data") summary.dataUnits += row.cost;
      if (row.bucket === "search") summary.searchCalls += row.cost;
      if (row.bucket === "upload") summary.uploadCalls += row.cost;
    }
    return summary;
  }

  saveSnapshots(snapshots: SnapshotVideo[]): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO video_snapshots(
        video_id, channel_id, title, published_at, view_count, like_count, comment_count, captured_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.exec("BEGIN");
    try {
      for (const item of snapshots) {
        insert.run(
          item.videoId,
          item.channelId,
          item.title,
          item.publishedAt,
          item.viewCount,
          item.likeCount,
          item.commentCount,
          item.capturedAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  snapshotHistory(videoIds: string[], limitPerVideo = 30): SnapshotVideo[] {
    if (videoIds.length === 0) return [];
    const placeholders = videoIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM (
          SELECT video_id, channel_id, title, published_at, view_count, like_count, comment_count,
                 captured_at,
                 ROW_NUMBER() OVER (PARTITION BY video_id ORDER BY captured_at DESC) AS row_num
          FROM video_snapshots WHERE video_id IN (${placeholders})
        ) WHERE row_num <= ? ORDER BY video_id, captured_at DESC`,
      )
      .all(...videoIds, limitPerVideo) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      videoId: String(row.video_id),
      channelId: row.channel_id === null ? null : String(row.channel_id),
      title: row.title === null ? null : String(row.title),
      publishedAt: row.published_at === null ? null : String(row.published_at),
      viewCount: row.view_count === null ? null : Number(row.view_count),
      likeCount: row.like_count === null ? null : Number(row.like_count),
      commentCount: row.comment_count === null ? null : Number(row.comment_count),
      capturedAt: String(row.captured_at),
    }));
  }

  getCache<T>(key: string): T | null {
    const row = this.db
      .prepare("SELECT value_json, expires_at FROM cache WHERE cache_key = ?")
      .get(key) as { value_json: string; expires_at: number } | undefined;
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      this.db.prepare("DELETE FROM cache WHERE cache_key = ?").run(key);
      return null;
    }
    return JSON.parse(row.value_json) as T;
  }

  setCache(key: string, value: unknown, ttlSeconds: number): void {
    this.db
      .prepare(
        `INSERT INTO cache(cache_key, value_json, expires_at) VALUES(?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET value_json=excluded.value_json, expires_at=excluded.expires_at`,
      )
      .run(key, JSON.stringify(value), Date.now() + ttlSeconds * 1000);
  }
}
