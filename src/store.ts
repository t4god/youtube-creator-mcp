import { DatabaseSync } from "node:sqlite";
import type { SnapshotVideo } from "./types.js";

export interface QuotaSummary {
  date: string;
  estimatedUnits: number;
  otherDataUnits: number;
  searchUnits: number;
  uploadUnits: number;
  calls: number;
}

export interface UploadOperation {
  operationId: string;
  fingerprint: string;
  state: "in_progress" | "completed" | "failed";
  videoId: string | null;
  response: unknown;
  error: unknown;
  createdAt: string;
  updatedAt: string;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
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

      CREATE TABLE IF NOT EXISTS upload_operations (
        operation_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('in_progress', 'completed', 'failed')),
        video_id TEXT,
        response_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS write_audit (
        id INTEGER PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        operation TEXT NOT NULL,
        target TEXT,
        confirmation TEXT NOT NULL,
        outcome TEXT NOT NULL,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS write_audit_time_idx ON write_audit(occurred_at DESC);
    `);
    this.db.exec("PRAGMA user_version=2; DELETE FROM cache WHERE expires_at <= unixepoch('now') * 1000;");
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
    const summary: QuotaSummary = {
      date,
      estimatedUnits: 0,
      otherDataUnits: 0,
      searchUnits: 0,
      uploadUnits: 0,
      calls: 0,
    };
    for (const row of rows) {
      if (formatter.format(new Date(row.occurred_at)) !== date) continue;
      summary.calls += 1;
      summary.estimatedUnits += row.cost;
      if (row.bucket === "data") summary.otherDataUnits += row.cost;
      if (row.bucket === "search") summary.searchUnits += row.cost;
      if (row.bucket === "upload") summary.uploadUnits += row.cost;
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

  getUploadOperation(operationId: string): UploadOperation | null {
    const row = this.db.prepare("SELECT * FROM upload_operations WHERE operation_id = ?").get(operationId) as
      | Record<string, string | null>
      | undefined;
    if (!row) return null;
    return {
      operationId: String(row.operation_id),
      fingerprint: String(row.fingerprint),
      state: row.state as UploadOperation["state"],
      videoId: row.video_id ?? null,
      response: row.response_json ? JSON.parse(row.response_json) : null,
      error: row.error_json ? JSON.parse(row.error_json) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  beginUploadOperation(operationId: string, fingerprint: string): { created: boolean; operation: UploadOperation } {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `INSERT INTO upload_operations(operation_id, fingerprint, state, created_at, updated_at)
       VALUES(?, ?, 'in_progress', ?, ?) ON CONFLICT(operation_id) DO NOTHING`,
    ).run(operationId, fingerprint, now, now);
    return { created: result.changes === 1, operation: this.getUploadOperation(operationId)! };
  }

  completeUploadOperation(operationId: string, videoId: string, response: unknown): void {
    this.db.prepare(
      `UPDATE upload_operations SET state='completed', video_id=?, response_json=?, error_json=NULL, updated_at=?
       WHERE operation_id=?`,
    ).run(videoId, JSON.stringify(response), new Date().toISOString(), operationId);
  }

  failUploadOperation(operationId: string, error: unknown): void {
    this.db.prepare(
      `UPDATE upload_operations SET state='failed', error_json=?, updated_at=? WHERE operation_id=?`,
    ).run(JSON.stringify(error), new Date().toISOString(), operationId);
  }

  recordWriteAudit(input: {
    operation: string;
    target?: string;
    confirmation: string;
    outcome: "started" | "succeeded" | "failed" | "deduplicated";
    details?: unknown;
  }): void {
    this.db.prepare(
      `INSERT INTO write_audit(occurred_at, operation, target, confirmation, outcome, details_json)
       VALUES(?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      input.operation,
      input.target ?? null,
      input.confirmation,
      input.outcome,
      input.details === undefined ? null : JSON.stringify(input.details),
    );
  }

  writeAudit(limit = 100): Array<Record<string, unknown>> {
    const rows = this.db.prepare(
      `SELECT occurred_at, operation, target, confirmation, outcome, details_json
       FROM write_audit ORDER BY id DESC LIMIT ?`,
    ).all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, string | null>>;
    return rows.map((row) => ({
      occurredAt: row.occurred_at,
      operation: row.operation,
      target: row.target,
      confirmation: row.confirmation,
      outcome: row.outcome,
      details: row.details_json ? JSON.parse(row.details_json) : null,
    }));
  }
}
