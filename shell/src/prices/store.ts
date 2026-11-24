// The price table in D1: dated snapshots kept beside each other. The current
// table is the newest snapshot not rolled back.

import { ROLL_BACK_STATEMENTS } from "./rollback";
import type { PriceRow, SourceResult } from "./types";

export interface Snapshot {
  id: number;
  takenAt: string;
  status: "good" | "partial" | "rolled_back";
  results: SourceResult[];
}

// Snapshots kept; older ones are deleted with their rows.
export const SNAPSHOTS_KEPT = 14;
// Rows per INSERT: they travel as one JSON parameter, under D1's 2 MB limit
// on a bound value, so a whole refresh is a handful of queries.
const ROWS_PER_INSERT = 4000;

type SnapshotRecord = { id: number; taken_at: string; status: Snapshot["status"]; results: string };
const toSnapshot = (r: SnapshotRecord): Snapshot => ({
  id: r.id,
  takenAt: r.taken_at,
  status: r.status,
  results: JSON.parse(r.results) as SourceResult[],
});

export async function currentSnapshot(db: D1Database): Promise<Snapshot | undefined> {
  const r = await db
    .prepare("SELECT id, taken_at, status, results FROM price_snapshots WHERE status != 'rolled_back' ORDER BY id DESC LIMIT 1")
    .first<SnapshotRecord>();
  return r ? toSnapshot(r) : undefined;
}

export async function listSnapshots(db: D1Database): Promise<Snapshot[]> {
  const { results } = await db
    .prepare("SELECT id, taken_at, status, results FROM price_snapshots ORDER BY id DESC")
    .all<SnapshotRecord>();
  return results.map(toSnapshot);
}

// The header, its rows and the pruning go in one batch, which D1 runs as one
// transaction: a write that fails leaves the previous snapshot current.
export async function writeSnapshot(
  db: D1Database,
  s: { takenAt: string; status: "good" | "partial"; results: SourceResult[]; rows: PriceRow[] },
): Promise<number> {
  const header = db
    .prepare("INSERT INTO price_snapshots (taken_at, status, results) VALUES (?, ?, ?) RETURNING id")
    .bind(s.takenAt, s.status, JSON.stringify(s.results));
  const insert = db.prepare(
    `INSERT INTO price_rows (snapshot_id, provider, model, deployment, region, token_kind, long_prompt, batch,
       usd_per_mtok, source, date_read, stale, disagreement)
     SELECT (SELECT max(id) FROM price_snapshots), j.value ->> 0, j.value ->> 1, j.value ->> 2, j.value ->> 3,
       j.value ->> 4, j.value ->> 5, j.value ->> 6, j.value ->> 7, j.value ->> 8, j.value ->> 9, j.value ->> 10, j.value ->> 11
     FROM json_each(?1) AS j`,
  );
  const statements: D1PreparedStatement[] = [header];
  for (let i = 0; i < s.rows.length; i += ROWS_PER_INSERT) {
    const chunk = s.rows.slice(i, i + ROWS_PER_INSERT).map((r) => [
      r.provider, r.model, r.deployment, r.region, r.tokenKind, r.longPrompt ? 1 : 0, r.batch ? 1 : 0,
      r.usdPerMTok, r.source, r.dateRead, r.stale ? 1 : 0, r.disagreement ? 1 : 0,
    ]);
    statements.push(insert.bind(JSON.stringify(chunk)));
  }
  // Older snapshots beyond the kept number go, with their rows.
  statements.push(
    db.prepare("DELETE FROM price_rows WHERE snapshot_id <= (SELECT max(id) FROM price_snapshots) - ?").bind(SNAPSHOTS_KEPT),
    db.prepare("DELETE FROM price_snapshots WHERE id <= (SELECT max(id) FROM price_snapshots) - ?").bind(SNAPSHOTS_KEPT),
  );
  const [created] = await db.batch<{ id: number }>(statements);
  const id = created?.results[0]?.id;
  if (id === undefined) throw new Error("could not create a price snapshot");
  return id;
}

type RowRecord = {
  provider: PriceRow["provider"]; model: string; deployment: PriceRow["deployment"]; region: string;
  token_kind: PriceRow["tokenKind"]; long_prompt: number; batch: number; usd_per_mtok: number;
  source: PriceRow["source"]; date_read: string; stale: number; disagreement: number;
};
const toRow = (r: RowRecord): PriceRow => ({
  provider: r.provider, model: r.model, deployment: r.deployment, region: r.region, tokenKind: r.token_kind,
  longPrompt: r.long_prompt === 1, batch: r.batch === 1, usdPerMTok: r.usd_per_mtok, source: r.source,
  dateRead: r.date_read, stale: r.stale === 1, disagreement: r.disagreement === 1,
});

export async function readSnapshotRows(db: D1Database, snapshotId: number): Promise<PriceRow[]> {
  const { results } = await db.prepare("SELECT * FROM price_rows WHERE snapshot_id = ?").bind(snapshotId).all<RowRecord>();
  return results.map(toRow);
}

export async function readModelRows(
  db: D1Database,
  snapshotId: number,
  key: { provider: string; model: string },
): Promise<PriceRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM price_rows WHERE snapshot_id = ? AND provider = ? AND model = ?")
    .bind(snapshotId, key.provider, key.model)
    .all<RowRecord>();
  return results.map(toRow);
}

export async function readRow(
  db: D1Database,
  snapshotId: number,
  key: { provider: string; model: string; location: string; tokenKind: string; longPrompt: boolean; batch: boolean },
): Promise<PriceRow | undefined> {
  // The location names a region ("us-east-1") or a deployment type ("global").
  const r = await db
    .prepare(
      `SELECT * FROM price_rows WHERE snapshot_id = ?1 AND provider = ?2 AND model = ?3 AND token_kind = ?4
         AND long_prompt = ?5 AND batch = ?6 AND (region = ?7 OR deployment = ?7)
       ORDER BY usd_per_mtok DESC LIMIT 1`,
    )
    .bind(snapshotId, key.provider, key.model, key.tokenKind, key.longPrompt ? 1 : 0, key.batch ? 1 : 0, key.location)
    .first<RowRecord>();
  return r ? toRow(r) : undefined;
}

// A bad refresh rolls back to the snapshot before it (rollback.ts). Returns
// the snapshot now current.
export async function rollBackLatestSnapshot(db: D1Database): Promise<Snapshot | undefined> {
  await db.batch(ROLL_BACK_STATEMENTS.map((sql) => db.prepare(sql)));
  return currentSnapshot(db);
}

export type AlertKind = "refresh_failed" | "sources_disagree" | "maintainer_reading_due" | "rolled_back";

export async function addAlert(db: D1Database, now: Date, kind: AlertKind, detail: string): Promise<void> {
  await db.prepare("INSERT INTO price_alerts (created_at, kind, detail) VALUES (?, ?, ?)").bind(now.toISOString(), kind, detail).run();
}

export async function recentAlerts(db: D1Database, limit = 10): Promise<Array<{ createdAt: string; kind: AlertKind; detail: string }>> {
  const { results } = await db
    .prepare("SELECT created_at, kind, detail FROM price_alerts ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all<{ created_at: string; kind: AlertKind; detail: string }>();
  return results.map((r) => ({ createdAt: r.created_at, kind: r.kind, detail: r.detail }));
}
