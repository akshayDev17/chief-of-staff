// The background read of the hosts a price snapshot's figures still wait for
// (src/prices/refresh.ts, src/prices/tiers.ts), so no figure depends on
// someone pressing Refresh model list or on the next daily refresh (the
// owner, 2026-11-28: the first page load after a deploy that adds new price
// data should not depend on either).
//
//   readHostsWaiting(db) -> HostsWaiting | undefined          what the pages say while they wait
//   readWaitingHosts({ db, fetcher, now }) -> Batch | undefined   one run of the every-minute Cron Trigger
//
// The current snapshot's hosts wait when Refresh model list left them for
// this read (a price_host_reads row, migration 0017), or when it has no
// figures at all: one the previous Worker wrote, before a release that
// stores them. A waiting model is one whose figure is still at its headline
// price as stored then (basis `unread`, read at or before the row's
// queued_at); a model tried since, read or not, waits no more.
//
// Every minute (src/index.ts) one run checks, with a single read and no
// write. When hosts wait, it takes them (a lease, so two runs never read the
// same batch), reads the endpoints lists of at most HOST_READS_PER_RUN of
// them, six at a time, and replaces those models' figures beside that same
// snapshot; the run that tries the last draws the first lines when no month
// has them. About 290 waiting hosts take five runs. Each run stays far inside
// a Workers Paid invocation's limits (10,000 subrequests; 30 s of CPU for a
// Cron Trigger more often than hourly;
// https://developers.cloudflare.com/workers/platform/limits/, read
// 2026-11-28): at most 2 x HOST_READS_PER_RUN lists (each tried twice at
// most) and a handful of D1 queries. A run that stops leaves its batch
// waiting, and another takes it once the lease is over. While hosts wait, a
// page that shows strength says so (models-table.ts, models/picker-page.ts,
// prices/page.ts), and Providers redraws in place as they land.

import { readAllHosts } from "./openrouter";
import { headlineFigures, headlinePrices, linesOver, strengthKey } from "./strength";
import {
  figureInserts,
  figureUpdate,
  linesInsert,
  readFigures,
  readLatestLines,
  readRowsOf,
  readSnapshotRows,
  readStoredCatalog,
  type StoredFigure,
} from "./store";
import { figureOf } from "./tiers";

// The endpoints lists one run reads: ten rounds of six.
export const HOST_READS_PER_RUN = 60;

// How long a run holds the waiting hosts: a Cron Trigger's longest run, so a
// run that stopped is taken over only once it cannot be still running.
export const HOST_READ_LEASE_MS = 15 * 60_000;

// What a page says while hosts wait: how many models' hosts are waiting and
// how many of them have been tried; `started`: a run has begun on them.
export interface HostsWaiting {
  waiting: number;
  done: number;
  started: boolean;
}

// One run's work: the snapshot, the lists it tried and how many still wait.
export interface Batch {
  snapshotId: number;
  tried: number;
  left: number;
}

type Due = {
  id: number;
  taken_at: string;
  waiting: number | null;
  done: number | null;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  has_figures: number;
};

// The current snapshot, its waiting hosts and whether it has figures, in one read.
const readDue = (db: D1Database): Promise<Due | null> =>
  db
    .prepare(
      `SELECT s.id, s.taken_at, h.waiting, h.done, h.queued_at, h.started_at, h.finished_at,
         EXISTS (SELECT 1 FROM model_price_figures f WHERE f.snapshot_id = s.id) AS has_figures
       FROM price_snapshots s LEFT JOIN price_host_reads h ON h.snapshot_id = s.id
       WHERE s.status != 'rolled_back' ORDER BY s.id DESC LIMIT 1`,
    )
    .first<Due>();

// A snapshot with no figures: each tiered model at its headline price.
async function headlineFiguresOf(db: D1Database, due: Due): Promise<StoredFigure[]> {
  const [rows, catalog] = await Promise.all([readSnapshotRows(db, due.id), readStoredCatalog(db, due.id)]);
  return headlineFigures(rows, catalog, due.taken_at);
}

const paid = (figures: readonly StoredFigure[]): number => figures.filter((f) => !f.free).length;

// The current snapshot's waiting hosts, if any wait.
export async function readHostsWaiting(db: D1Database): Promise<HostsWaiting | undefined> {
  const due = await readDue(db);
  if (!due) return undefined;
  if (due.waiting !== null) return due.finished_at === null ? { waiting: due.waiting, done: due.done ?? 0, started: (due.done ?? 0) > 0 || due.started_at !== null } : undefined;
  if (due.has_figures) return undefined;
  const waiting = paid(await headlineFiguresOf(db, due));
  return waiting ? { waiting, done: 0, started: false } : undefined;
}

// One run: when the current snapshot's hosts wait and no other run holds
// them, read a batch of them and store their figures. Undefined when nothing
// waited or another run holds them: then it read once and wrote nothing.
export async function readWaitingHosts(input: { db: D1Database; fetcher: typeof fetch; now: Date; hostRetryPauseMs?: number }): Promise<Batch | undefined> {
  const { db, now } = input;
  const due = await readDue(db);
  if (!due) return undefined;
  let queuedAt: string;
  if (!due.has_figures) {
    // Each model at its headline price first, all of them waiting.
    const figures = await headlineFiguresOf(db, due);
    if (!paid(figures)) return undefined;
    await db.batch([
      ...figureInserts(db, figures, due.id),
      db.prepare("INSERT INTO price_host_reads (snapshot_id, waiting, queued_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING").bind(due.id, paid(figures), due.taken_at),
    ]);
    queuedAt = due.taken_at;
  } else if (due.queued_at !== null && due.finished_at === null) {
    queuedAt = due.queued_at;
  } else {
    return undefined;
  }

  const at = now.toISOString();
  const { meta } = await db
    .prepare("UPDATE price_host_reads SET started_at = ?1 WHERE snapshot_id = ?2 AND finished_at IS NULL AND (started_at IS NULL OR started_at < ?3)")
    .bind(at, due.id, new Date(now.getTime() - HOST_READ_LEASE_MS).toISOString())
    .run();
  if (!meta.changes) return undefined;

  const waiting = (await readFigures(db, due.id)).filter((f) => !f.free && f.basis === "unread" && f.readAt <= queuedAt).sort((a, b) => (a.model < b.model ? -1 : 1));
  const batch = waiting.slice(0, HOST_READS_PER_RUN);
  const headlines = headlinePrices(await readRowsOf(db, due.id, batch.map((f) => f.model)));
  const hosts = await readAllHosts(input.fetcher, batch.map((f) => f.model), input.hostRetryPauseMs);
  // A model tried now waits no more, its list read or not.
  const tried: StoredFigure[] = batch.map((f) => {
    const headline = headlines.get(strengthKey(f));
    return headline ? { provider: f.provider, model: f.model, free: false, ...figureOf(hosts.get(f.model), headline, at) } : { ...f, readAt: at };
  });
  const left = waiting.length - batch.length;
  const statements = [
    ...tried.map((f) => figureUpdate(db, due.id, f)),
    db
      .prepare("UPDATE price_host_reads SET done = done + ?1, started_at = NULL, finished_at = ?2 WHERE snapshot_id = ?3")
      .bind(tried.length, left ? null : at, due.id),
  ];
  // The last batch draws the first lines of all, from host figures.
  if (!left && !(await readLatestLines(db))) {
    const byKey = new Map(tried.map((f) => [strengthKey(f), f]));
    const lines = linesOver((await readFigures(db, due.id)).map((f) => byKey.get(strengthKey(f)) ?? f), now);
    if (lines) statements.push(linesInsert(db, lines, due.id));
  }
  await db.batch(statements);
  return { snapshotId: due.id, tried: tried.length, left };
}
