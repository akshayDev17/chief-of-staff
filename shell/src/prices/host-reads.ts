// The background read of the hosts a price snapshot's figures still wait for
// (src/prices/refresh.ts, src/prices/tiers.ts), so no figure depends on
// someone pressing Refresh model list or on the next daily refresh (the
// owner, 2026-11-28: the first page load after a deploy that adds new price
// data should not depend on either).
//
//   readHostsWaiting(db, snapshot?) -> HostsWaiting | undefined      what the pages say while they wait
//   readWaitingHosts({ db, fetcher, now }) -> number | undefined      the every-minute Cron Trigger's job
//
// The current snapshot's hosts wait when Refresh model list left them for
// this read (a price_host_reads row, migration 0017), or when it has no
// figures at all: one the previous Worker wrote, before a release that
// stores them. Every minute (src/index.ts) the Cron Trigger checks; when they
// wait, it takes them (a lease, so two minutes' runs never read them twice)
// and runs the refresh itself, as the daily refresh does, which reads every
// model whose figure is not held and stores the next snapshot. A Cron
// Trigger may run 15 minutes (https://developers.cloudflare.com/workers/platform/limits/,
// read 2026-11-28), far beyond the read of about 280 lists, and its own
// request is never a browser's, so no proxy timeout ends it. A run that
// stops before it stores anything leaves them waiting, and the next minute
// after the lease takes them again. While they wait, a page that shows
// strength says so (models-table.ts, models/picker-page.ts, prices/page.ts),
// and Providers redraws in place when they land.

import { refreshPrices } from "./refresh";
import { tieredModels } from "./strength";
import { currentSnapshot, hasFigures, readHostReads, readSnapshotRows, readStoredCatalog, type Snapshot } from "./store";

// How long a background read holds the waiting hosts: a Cron Trigger's
// longest run, so a run that stopped is taken over only once it cannot be
// still running.
export const HOST_READ_LEASE_MS = 15 * 60_000;

// The background read writes how many lists it has tried this often.
const PROGRESS_EVERY = 12;

// What a page says while hosts wait: how many models' hosts are waiting and
// how many of them the background read has tried; `started`: it has begun.
export interface HostsWaiting {
  waiting: number;
  done: number;
  started: boolean;
}

// The paid models a snapshot with no figures would read the hosts of.
async function paidTiered(db: D1Database, snapshotId: number): Promise<number> {
  const [rows, catalog] = await Promise.all([readSnapshotRows(db, snapshotId), readStoredCatalog(db, snapshotId)]);
  return tieredModels(rows, catalog).filter((t) => !t.free).length;
}

// The current snapshot's waiting hosts, if any wait.
export async function readHostsWaiting(db: D1Database, snapshot?: Snapshot): Promise<HostsWaiting | undefined> {
  const s = snapshot ?? (await currentSnapshot(db));
  if (!s) return undefined;
  const row = await readHostReads(db, s.id);
  if (row) return { waiting: row.waiting, done: row.done, started: row.startedAt !== undefined };
  if (await hasFigures(db, s.id)) return undefined;
  const waiting = await paidTiered(db, s.id);
  return waiting ? { waiting, done: 0, started: false } : undefined;
}

// The background read: when the current snapshot's hosts wait and no other
// run holds them, read them and store the next snapshot. Returns its id, or
// undefined when nothing waited or another run holds them.
export async function readWaitingHosts(input: { db: D1Database; fetcher: typeof fetch; now: Date; hostRetryPauseMs?: number }): Promise<number | undefined> {
  const { db, now } = input;
  const waiting = await readHostsWaiting(db);
  const snapshot = waiting ? await currentSnapshot(db) : undefined;
  if (!waiting || !snapshot) return undefined;
  const at = now.toISOString();
  const { results } = await db
    .prepare(
      `INSERT INTO price_host_reads (snapshot_id, waiting, queued_at, started_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT (snapshot_id) DO UPDATE SET started_at = excluded.started_at, done = 0
       WHERE price_host_reads.started_at IS NULL OR price_host_reads.started_at < ?4
       RETURNING snapshot_id`,
    )
    .bind(snapshot.id, waiting.waiting, at, new Date(now.getTime() - HOST_READ_LEASE_MS).toISOString())
    .all();
  if (!results.length) return undefined;
  const progress = (sql: string, ...values: number[]) => db.prepare(sql).bind(...values, snapshot.id).run();
  const { snapshotId } = await refreshPrices({
    db,
    fetcher: input.fetcher,
    now,
    ...(input.hostRetryPauseMs !== undefined ? { hostRetryPauseMs: input.hostRetryPauseMs } : {}),
    background: {
      onRead: async (tried, of) => {
        if (tried === 0) await progress("UPDATE price_host_reads SET waiting = ?1, done = 0 WHERE snapshot_id = ?2", of);
        else if (tried % PROGRESS_EVERY === 0 || tried === of) await progress("UPDATE price_host_reads SET done = ?1 WHERE snapshot_id = ?2", tried);
      },
    },
  });
  return snapshotId;
}
