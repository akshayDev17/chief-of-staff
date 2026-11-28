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
//
// Strength (src/prices/tiers.ts) needs each tiered model's hosts, from its
// endpoints list: about 290 more reads, one per model, six at a time. The
// daily refresh reads every model's (a Cron Trigger has 15 minutes and, on
// Workers Paid, 10,000 subrequests,
// https://developers.cloudflare.com/workers/platform/limits/, read
// 2026-11-28). Refresh model list, which the user waits on, reads only the
// models that are new, whose headline price changed or whose hosts were last
// not read; every other model keeps its last figure. A list that cannot be
// read keeps the model's last figure from hosts while its headline holds,
// and is otherwise its headline price. The daily refresh also works out the
// month's lines, once, at the month's first good read; a refresh before any
// month has lines works them out then, and none ever replaces a month's.

import { readAllHosts, readOpenRouter } from "./openrouter";
import { headlineFigure, headlineFigures, headlinePrices, linesOver, strengthKey, tieredModels } from "./strength";
import { addAlert, currentSnapshot, readFigures, readLatestLines, readSnapshotRows, readStoredCatalog, writeSnapshot, type StoredFigure } from "./store";
import { figureOf, type Lines } from "./tiers";
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
  // The daily refresh (the Cron Trigger), not Refresh model list.
  daily?: boolean;
  // The pause before a busy endpoints list is read again.
  hostRetryPauseMs?: number;
}

// The figures for a snapshot of `rows` (src/prices/strength.ts). `previous`:
// the last snapshot's figures; `before`: its headline prices.
async function figuresFor(
  input: RefreshInput,
  rows: PriceRow[],
  catalog: Parameters<typeof tieredModels>[1],
  previous: Map<string, StoredFigure>,
  before: Map<string, { input: number; output: number }>,
): Promise<StoredFigure[]> {
  const readAt = input.now.toISOString();
  const targets = tieredModels(rows, catalog);
  const headlineHolds = (t: (typeof targets)[number]) => {
    const b = before.get(strengthKey(t));
    return b !== undefined && b.input === t.headline.input && b.output === t.headline.output;
  };
  const toRead = targets.filter((t) => {
    if (t.free) return false;
    if (input.daily) return true;
    const p = previous.get(strengthKey(t));
    return !p || p.basis === "unread" || !headlineHolds(t);
  });
  const hosts = await readAllHosts(input.fetcher, toRead.map((t) => t.model), input.hostRetryPauseMs);
  return targets.map((t) => {
    if (t.free) return headlineFigure(t, readAt);
    const read = hosts.get(t.model);
    if (read) return { provider: t.provider, model: t.model, free: false, ...figureOf(read, t.headline, readAt) };
    const p = previous.get(strengthKey(t));
    if (p && p.basis !== "unread" && headlineHolds(t)) return p;
    return headlineFigure(t, readAt);
  });
}

export async function refreshPrices(input: RefreshInput): Promise<{ snapshotId: number; results: SourceResult[] }> {
  const { db, fetcher, now } = input;
  const { read, catalog: catalogRead } = await readOpenRouter(fetcher, now);
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
  // A failed read keeps the last snapshot's figures with its rows.
  const previous = last ? await readFigures(db, last.id) : [];
  const figures = read.ok
    ? await figuresFor(input, merged.rows, catalog, new Map(previous.map((f) => [strengthKey(f), f])), headlinePrices(lastRows))
    : previous.length ? previous : headlineFigures(merged.rows, catalog, now.toISOString());
  const latestLines = await readLatestLines(db);
  const lines: Lines | undefined =
    read.ok && (!latestLines || (input.daily && latestLines.month < now.toISOString().slice(0, 7))) ? linesOver(figures, now) : undefined;
  let snapshotId: number;
  try {
    snapshotId = await writeSnapshot(db, {
      takenAt: now.toISOString(),
      status: failed.length ? "partial" : "good",
      results,
      rows: merged.rows,
      catalog,
      figures,
      ...(lines ? { lines } : {}),
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
