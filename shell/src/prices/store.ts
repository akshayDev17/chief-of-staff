// The price table in D1: dated snapshots kept beside each other. The current
// table is the newest snapshot not rolled back.

import type { OpenRouterCatalog } from "./openrouter";
import { ROLL_BACK_REFUSED, ROLL_BACK_STATEMENTS } from "./rollback";
import type { Basis, Figure, Lines } from "./tiers";
import type { PriceRow, Provider, SourceResult } from "./types";

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

// A model's figure as stored beside a snapshot (src/prices/tiers.ts); `free`:
// a free model's, at 0, which the lines do not count.
export interface StoredFigure extends Figure {
  provider: Provider;
  model: string;
  free: boolean;
}

// The header, its rows, OpenRouter's model list read with them
// (src/prices/openrouter.ts), each model's figure, the month's lines when
// this refresh works them out, and the pruning go in one batch, which D1
// runs as one transaction: a write that fails leaves the previous snapshot
// current, and no lines point at a snapshot that was not stored.
export async function writeSnapshot(
  db: D1Database,
  s: {
    takenAt: string;
    status: "good" | "partial";
    results: SourceResult[];
    rows: PriceRow[];
    catalog?: OpenRouterCatalog;
    figures?: StoredFigure[];
    lines?: Lines;
  },
): Promise<number> {
  const header = db
    .prepare("INSERT INTO price_snapshots (taken_at, status, results) VALUES (?, ?, ?) RETURNING id")
    .bind(s.takenAt, s.status, JSON.stringify(s.results));
  const insert = db.prepare(
    `INSERT INTO model_price_rows (snapshot_id, provider, model, deployment, region, token_kind, long_prompt, batch,
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
  if (s.catalog) {
    statements.push(
      db
        .prepare("INSERT INTO openrouter_catalogs (snapshot_id, read_at, catalog) SELECT max(id), ?1, ?2 FROM price_snapshots")
        .bind(s.catalog.readAt, JSON.stringify(s.catalog)),
    );
  }
  const figure = db.prepare(
    `INSERT INTO model_price_figures (snapshot_id, provider, model, usd_per_mtok, basis, free, hosts, input_min, input_max,
       output_min, output_max, read_at)
     SELECT (SELECT max(id) FROM price_snapshots), j.value ->> 0, j.value ->> 1, j.value ->> 2, j.value ->> 3, j.value ->> 4,
       j.value ->> 5, j.value ->> 6, j.value ->> 7, j.value ->> 8, j.value ->> 9, j.value ->> 10
     FROM json_each(?1) AS j`,
  );
  const figures = s.figures ?? [];
  for (let i = 0; i < figures.length; i += ROWS_PER_INSERT) {
    const chunk = figures.slice(i, i + ROWS_PER_INSERT).map((f) => [
      f.provider, f.model, f.usd, f.basis, f.free ? 1 : 0, f.hosts, f.input?.min ?? null, f.input?.max ?? null,
      f.output?.min ?? null, f.output?.max ?? null, f.readAt,
    ]);
    statements.push(figure.bind(JSON.stringify(chunk)));
  }
  if (s.lines) {
    const l = s.lines;
    statements.push(
      db
        .prepare(
          `INSERT INTO strength_lines (month, lower_usd, upper_usd, lower_raw, upper_raw, models, snapshot_id, computed_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, max(id), ?7 FROM price_snapshots WHERE true ON CONFLICT (month) DO NOTHING`,
        )
        .bind(l.month, l.lower, l.upper, l.lowerRaw, l.upperRaw, l.models, l.computedAt),
    );
  }
  // Older snapshots beyond the kept number go, with their rows and lists. The
  // tables the previous Worker wrote (price_rows, bedrock_catalogs) are
  // pruned with them too, until a later release drops those tables.
  const prune = (table: string) =>
    db.prepare(`DELETE FROM ${table} WHERE snapshot_id <= (SELECT max(id) FROM price_snapshots) - ?`).bind(SNAPSHOTS_KEPT);
  statements.push(
    prune("model_price_rows"),
    prune("model_price_figures"),
    prune("openrouter_catalogs"),
    prune("price_rows"),
    prune("bedrock_catalogs"),
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

type FigureRecord = {
  provider: Provider; model: string; usd_per_mtok: number; basis: Basis; free: number; hosts: number;
  input_min: number | null; input_max: number | null; output_min: number | null; output_max: number | null; read_at: string;
};
const toFigure = (r: FigureRecord): StoredFigure => ({
  provider: r.provider, model: r.model, usd: r.usd_per_mtok, basis: r.basis, free: r.free === 1, hosts: r.hosts,
  ...(r.input_min !== null && r.input_max !== null ? { input: { min: r.input_min, max: r.input_max } } : {}),
  ...(r.output_min !== null && r.output_max !== null ? { output: { min: r.output_min, max: r.output_max } } : {}),
  readAt: r.read_at,
});

// Every model's figure stored beside a snapshot; none for a snapshot the
// previous Worker wrote.
export async function readFigures(db: D1Database, snapshotId: number): Promise<StoredFigure[]> {
  const { results } = await db.prepare("SELECT * FROM model_price_figures WHERE snapshot_id = ?").bind(snapshotId).all<FigureRecord>();
  return results.map(toFigure);
}

// One model's figure beside a snapshot, and whether the snapshot has any.
export async function readFigure(
  db: D1Database,
  snapshotId: number,
  key: { provider: string; model: string },
): Promise<{ figure?: StoredFigure; any: boolean }> {
  const { results } = await db
    .prepare(
      `SELECT * FROM model_price_figures WHERE snapshot_id = ?1 AND provider = ?2 AND model = ?3
       UNION ALL SELECT * FROM (SELECT * FROM model_price_figures WHERE snapshot_id = ?1 LIMIT 1)`,
    )
    .bind(snapshotId, key.provider, key.model)
    .all<FigureRecord>();
  const figure = results.find((r) => r.provider === key.provider && r.model === key.model);
  return { ...(figure ? { figure: toFigure(figure) } : {}), any: results.length > 0 };
}

type LinesRecord = { month: string; lower_usd: number; upper_usd: number; lower_raw: number; upper_raw: number; models: number; computed_at: string };

// The newest month's lines, if any month has them.
export async function readLatestLines(db: D1Database): Promise<Lines | undefined> {
  const r = await db.prepare("SELECT * FROM strength_lines ORDER BY month DESC LIMIT 1").first<LinesRecord>();
  return r
    ? { month: r.month, lower: r.lower_usd, upper: r.upper_usd, lowerRaw: r.lower_raw, upperRaw: r.upper_raw, models: r.models, computedAt: r.computed_at }
    : undefined;
}

// OpenRouter's model list stored with a snapshot, if one was.
export async function readStoredCatalog(db: D1Database, snapshotId: number): Promise<OpenRouterCatalog | undefined> {
  const r = await db.prepare("SELECT catalog FROM openrouter_catalogs WHERE snapshot_id = ?").bind(snapshotId).first<{ catalog: string }>();
  return r ? (JSON.parse(r.catalog) as OpenRouterCatalog) : undefined;
}

// The current snapshot's OpenRouter model list, if it has one.
export async function readCurrentCatalog(db: D1Database): Promise<OpenRouterCatalog | undefined> {
  const snapshot = await currentSnapshot(db);
  return snapshot ? readStoredCatalog(db, snapshot.id) : undefined;
}

export async function readSnapshotRows(db: D1Database, snapshotId: number): Promise<PriceRow[]> {
  const { results } = await db.prepare("SELECT * FROM model_price_rows WHERE snapshot_id = ?").bind(snapshotId).all<RowRecord>();
  return results.map(toRow);
}

export async function readModelRows(
  db: D1Database,
  snapshotId: number,
  key: { provider: string; model: string },
): Promise<PriceRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM model_price_rows WHERE snapshot_id = ? AND provider = ? AND model = ?")
    .bind(snapshotId, key.provider, key.model)
    .all<RowRecord>();
  return results.map(toRow);
}

export async function readRow(
  db: D1Database,
  snapshotId: number,
  key: { provider: string; model: string; location: string; tokenKind: string; longPrompt: boolean; batch: boolean },
): Promise<PriceRow | undefined> {
  // The location names a region or a deployment type (`global` on OpenRouter).
  const r = await db
    .prepare(
      `SELECT * FROM model_price_rows WHERE snapshot_id = ?1 AND provider = ?2 AND model = ?3 AND token_kind = ?4
         AND long_prompt = ?5 AND batch = ?6 AND (region = ?7 OR deployment = ?7)
       ORDER BY usd_per_mtok DESC LIMIT 1`,
    )
    .bind(snapshotId, key.provider, key.model, key.tokenKind, key.longPrompt ? 1 : 0, key.batch ? 1 : 0, key.location)
    .first<RowRecord>();
  return r ? toRow(r) : undefined;
}

// A bad refresh rolls back to the snapshot before it (rollback.ts). Returns
// the snapshot now current; throws, changing nothing, when no earlier
// snapshot would stay current.
export async function rollBackLatestSnapshot(db: D1Database): Promise<Snapshot | undefined> {
  const results = await db.batch<{ rolled_back: number }>(ROLL_BACK_STATEMENTS.map((sql) => db.prepare(sql)));
  if (!results.at(-1)?.results[0]?.rolled_back) throw new Error(ROLL_BACK_REFUSED);
  return currentSnapshot(db);
}

// `price_missing` is raised by the model proxy (T12) when a call used a kind
// of token its model has no list price for.
export type AlertKind = "refresh_failed" | "sources_disagree" | "maintainer_reading_due" | "rolled_back" | "price_missing";

export async function addAlert(db: D1Database, now: Date, kind: AlertKind, detail: string): Promise<void> {
  await db.prepare("INSERT INTO price_alerts (created_at, kind, detail) VALUES (?, ?, ?)").bind(now.toISOString(), kind, detail).run();
}

// The same alert at most once per UTC day, for alerts raised per call rather
// than per run. True when it was raised now.
export async function addAlertOncePerDay(db: D1Database, now: Date, kind: AlertKind, detail: string): Promise<boolean> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const { meta } = await db
    .prepare(
      `INSERT INTO price_alerts (created_at, kind, detail) SELECT ?1, ?2, ?3
       WHERE NOT EXISTS (SELECT 1 FROM price_alerts WHERE kind = ?2 AND detail = ?3 AND created_at >= ?4)`,
    )
    .bind(now.toISOString(), kind, detail, dayStart)
    .run();
  return meta.changes > 0;
}

export async function recentAlerts(db: D1Database, limit = 10): Promise<Array<{ createdAt: string; kind: AlertKind; detail: string }>> {
  const { results } = await db
    .prepare("SELECT created_at, kind, detail FROM price_alerts ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all<{ created_at: string; kind: AlertKind; detail: string }>();
  return results.map((r) => ({ createdAt: r.created_at, kind: r.kind, detail: r.detail }));
}
