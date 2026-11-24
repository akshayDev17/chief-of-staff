// The daily refresh: read every source, merge, and store a dated snapshot
// beside the previous ones. Rules (design-v3 1.3):
// - A source that fails keeps its rows from the last snapshot, with their own
//   date read, marked stale; nothing is guessed in their place, and a
//   refresh-failed alert is raised.
// - A source that answers stores what the vendor lists, however many rows: a
//   model no longer listed has no price yet. Each source's result counts the
//   rows added and dropped against the previous snapshot.
// - Two sources (or two listings in one source) giving one row different
//   prices keep the higher price, flagged, with a sources-disagree alert.

import { readAws } from "./aws";
import { readAzure } from "./azure";
import { readGoogle } from "./google";
import { rowsFromMaintainerEntries, type MaintainerEntry } from "./maintainer";
import { addAlert, currentSnapshot, readSnapshotRows, writeSnapshot } from "./store";
import { rowKey, type PriceRow, type SourceId, type SourceRead, type SourceResult } from "./types";

export function mergeRows(rows: PriceRow[]): { rows: PriceRow[]; disagreements: string[] } {
  const byKey = new Map<string, PriceRow>();
  const disagreements = new Set<string>();
  for (const row of rows) {
    const key = rowKey(row);
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, row);
      continue;
    }
    if (seen.usdPerMTok !== row.usdPerMTok) {
      disagreements.add(`${row.provider} ${row.model} ${row.region} ${row.tokenKind}: ${seen.usdPerMTok} vs ${row.usdPerMTok}`);
      const higher = row.usdPerMTok > seen.usdPerMTok ? row : seen;
      byKey.set(key, { ...higher, disagreement: true });
    }
  }
  return { rows: [...byKey.values()], disagreements: [...disagreements] };
}

export interface RefreshInput {
  db: D1Database;
  fetcher: typeof fetch;
  googleApiKey: string | undefined;
  maintainerEntries: MaintainerEntry[];
  now: Date;
}

export async function refreshPrices(input: RefreshInput): Promise<{ snapshotId: number; results: SourceResult[] }> {
  const { db, fetcher, now } = input;
  const today = now.toISOString().slice(0, 10);
  const reads: SourceRead[] = await Promise.all([
    readAzure(fetcher, today),
    readAws(fetcher, today),
    readGoogle(fetcher, input.googleApiKey, today),
  ]);
  reads.push({ source: "maintainer-read", ok: true, rows: rowsFromMaintainerEntries(input.maintainerEntries), unmapped: 0 });

  const last = await currentSnapshot(db);
  const lastRows = last ? await readSnapshotRows(db, last.id) : [];
  const lastBySource = (source: SourceId) => lastRows.filter((r) => r.source === source);

  const rows: PriceRow[] = [];
  const outcomes: Array<Omit<SourceResult, "added" | "dropped">> = [];
  for (const read of reads) {
    if (read.ok) {
      rows.push(...read.rows);
      outcomes.push({ source: read.source, ok: true, rows: read.rows.length, unmapped: read.unmapped });
    } else {
      const previous = lastBySource(read.source);
      rows.push(...previous.map((r) => ({ ...r, stale: true })));
      outcomes.push({ source: read.source, ok: false, rows: previous.length, unmapped: 0, error: read.error });
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
  let snapshotId: number;
  try {
    snapshotId = await writeSnapshot(db, {
      takenAt: now.toISOString(),
      status: failed.length ? "partial" : "good",
      results,
      rows: merged.rows,
    });
  } catch (error) {
    const detail = `could not store the snapshot, the previous one stays current: ${error instanceof Error ? error.message : String(error)}`;
    console.warn(`price refresh failed: ${detail}`);
    await addAlert(db, now, "refresh_failed", detail);
    throw error;
  }
  for (const f of failed) {
    const detail = `${f.source}: ${f.error}`;
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
