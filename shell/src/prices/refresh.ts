// The daily refresh, and Refresh model list: read the price source, merge,
// and store a dated snapshot beside the previous ones. Rules (design-v3 1.3):
// - A source that fails keeps its rows from the last snapshot, with their own
//   date read, marked stale; nothing is guessed in their place, and a
//   refresh-failed alert is raised. OpenRouter's model list read with them
//   is kept from the last snapshot too.
// - A source that answers stores what it lists, however many rows: a model no
//   longer listed has no price yet. Each source's result counts the rows
//   added and dropped against the previous snapshot.
// - Two listings giving one row different prices keep the higher price,
//   flagged, with a sources-disagree alert.
//
// The one source is OpenRouter's models API (src/prices/openrouter.ts), which
// also gives the model list each user chooses from.

import { CATALOG_VERSION, readOpenRouter, type OpenRouterCatalog } from "./openrouter";
import { addAlert, currentSnapshot, newestAlertAt, readCurrentCatalog, readSnapshotRows, readStoredCatalog, writeSnapshot } from "./store";
import { rowKey, type PriceRow, type SourceId, type SourceResult } from "./types";

export function mergeRows(rows: PriceRow[]): { rows: PriceRow[]; disagreements: string[] } {
  const byKey = new Map<string, PriceRow>();
  // Every price seen for each disagreeing row, so the alert names each row once.
  const disagreeing = new Map<string, { row: PriceRow; prices: Set<number> }>();
  for (const row of rows) {
    const key = rowKey(row);
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, row);
      continue;
    }
    if (seen.usdPerMTok !== row.usdPerMTok) {
      const entry = disagreeing.get(key) ?? { row, prices: new Set([seen.usdPerMTok]) };
      entry.prices.add(row.usdPerMTok);
      disagreeing.set(key, entry);
      const higher = row.usdPerMTok > seen.usdPerMTok ? row : seen;
      byKey.set(key, { ...higher, disagreement: true });
    }
  }
  const disagreements = [...disagreeing.values()].map(
    ({ row, prices }) =>
      `${row.provider} ${row.model} ${row.deployment} ${row.region} ${row.tokenKind}${row.batch ? " batch" : ""}${row.longPrompt ? " long prompt" : ""}: ${[...prices].sort((a, b) => a - b).join(" vs ")}`,
  );
  return { rows: [...byKey.values()], disagreements };
}

export interface RefreshInput {
  db: D1Database;
  fetcher: typeof fetch;
  now: Date;
}

export async function refreshPrices(input: RefreshInput): Promise<{ snapshotId: number; results: SourceResult[] }> {
  return storeRead(input, await readOpenRouter(input.fetcher, input.now));
}

// The snapshot from one read of OpenRouter's models API, good or failed.
async function storeRead(input: RefreshInput, { read, catalog: catalogRead }: OpenRouterRead): Promise<{ snapshotId: number; results: SourceResult[] }> {
  const { db, now } = input;
  const reads = [read];

  const last = await currentSnapshot(db);
  const lastRows = last ? await readSnapshotRows(db, last.id) : [];
  const lastBySource = (source: SourceId) => lastRows.filter((r) => r.source === source);

  const rows: PriceRow[] = [];
  const outcomes: Array<Omit<SourceResult, "added" | "dropped">> = [];
  for (const r of reads) {
    if (r.ok) {
      rows.push(...r.rows);
      outcomes.push({ source: r.source, ok: true, rows: r.rows.length, unmapped: r.unmapped });
    } else {
      const previous = lastBySource(r.source);
      rows.push(...previous.map((p) => ({ ...p, stale: true })));
      outcomes.push({ source: r.source, ok: false, rows: previous.length, unmapped: 0, error: r.error });
    }
  }

  const merged = mergeRows(rows);
  const keysOf = (source: SourceId, from: PriceRow[]) => new Set(from.filter((r) => r.source === source).map(rowKey));
  const results: SourceResult[] = outcomes.map((r) => {
    const after = keysOf(r.source, merged.rows);
    const before = keysOf(r.source, lastRows);
    return {
      ...r,
      added: [...after].filter((k) => !before.has(k)).length,
      dropped: [...before].filter((k) => !after.has(k)).length,
    };
  });
  const failed = results.filter((r) => !r.ok);
  const catalog = catalogRead ?? (last ? await readStoredCatalog(db, last.id) : undefined);
  let snapshotId: number;
  try {
    snapshotId = await writeSnapshot(db, {
      takenAt: now.toISOString(),
      status: failed.length ? "partial" : "good",
      results,
      rows: merged.rows,
      catalog,
    });
  } catch (error) {
    const detail = `could not store the snapshot, the previous one stays current: ${error instanceof Error ? error.message : String(error)}`;
    console.warn(`price refresh failed: ${detail}`);
    await addAlert(db, now, "refresh_failed", detail);
    throw error;
  }
  for (const f of failed) {
    const detail =
      `${f.source}: ${f.error}. ` +
      (catalog ? `OpenRouter's model list read ${catalog.readAt} stays in use, its prices marked stale.` : "Until the first good read, no model can be chosen.");
    console.warn(`price refresh failed: ${detail}`);
    await addAlert(db, now, "refresh_failed", detail);
  }
  if (merged.disagreements.length) {
    const detail = `${merged.disagreements.length} rows: ${merged.disagreements.slice(0, 20).join("; ")}`;
    console.warn(`price sources disagree: ${detail}`);
    await addAlert(db, now, "sources_disagree", detail);
  }
  return { snapshotId, results };
}

type OpenRouterRead = Awaited<ReturnType<typeof readOpenRouter>>;

// Refresh model list reads again at most once a minute, a failed read included.
export const REFRESH_GAP_MS = 60_000;
// A stale model list is read again at most this often after a failed read.
export const STALE_RETRY_MS = 15 * 60_000;

// The stored model list follows parseModels' current rules.
export const isCurrentCatalog = (catalog: OpenRouterCatalog | undefined): boolean => catalog?.version === CATALOG_VERSION;

// Before a screen or the minute cron uses the model list (the Providers
// routes, Model for each task, the every-minute cron). Forced (Refresh model
// list): a refresh as the daily one, at most once a minute by the newest
// snapshot. Otherwise only when there is no list yet or the stored one
// predates parseModels' rules: a failed read stores no snapshot, so the
// stored list and its prices stay as they are, raises one refresh_failed
// alert, and is tried again once the newest such alert is 15 minutes old.
// True when it stored a snapshot.
export async function refreshStaleCatalog(input: RefreshInput & { force?: boolean }): Promise<boolean> {
  const { db, now } = input;
  if (input.force) {
    const snapshot = await currentSnapshot(db);
    if (snapshot && now.getTime() - Date.parse(snapshot.takenAt) < REFRESH_GAP_MS) return false;
    await refreshPrices(input);
    return true;
  }
  if (isCurrentCatalog(await readCurrentCatalog(db))) return false;
  const failedAt = await newestAlertAt(db, "refresh_failed");
  if (failedAt && now.getTime() - Date.parse(failedAt) < STALE_RETRY_MS) return false;
  const read = await readOpenRouter(input.fetcher, now);
  if (!read.read.ok) {
    const detail = `${read.read.source}: ${read.read.error}. The stored model list predates the app's rules and stays in use; it is read again in 15 minutes.`;
    console.warn(`price refresh failed: ${detail}`);
    await addAlert(db, now, "refresh_failed", detail);
    return false;
  }
  await storeRead(input, read);
  return true;
}
