// The daily refresh: read every source, merge, and store a dated snapshot
// beside the previous ones. Rules (design-v3 1.3):
// - A source that fails keeps its rows from the last snapshot, with their own
//   date read, marked stale; nothing is guessed in their place, and a
//   refresh-failed alert is raised.
// - A source whose read is far smaller than its last good read is treated as
//   failed too: a bad refresh never replaces a good table.
// - Two sources (or two listings in one source) giving one row different
//   prices keep the higher price, flagged, with a sources-disagree alert.

import { readAws } from "./aws";
import { readAzure } from "./azure";
import { readGoogle } from "./google";
import { rowsFromMaintainerEntries, type MaintainerEntry } from "./maintainer";
import { addAlert, currentSnapshot, readSnapshotRows, writeSnapshot } from "./store";
import { rowKey, type PriceRow, type SourceId, type SourceRead, type SourceResult } from "./types";

// A read with fewer rows than this share of the last good read is refused.
const MIN_SHARE_OF_LAST = 0.5;

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
  const results: SourceResult[] = [];
  for (let read of reads) {
    const previous = lastBySource(read.source);
    if (read.ok && read.source !== "maintainer-read" && read.rows.length < previous.length * MIN_SHARE_OF_LAST) {
      read = {
        source: read.source,
        ok: false,
        error: `read only ${read.rows.length} rows against ${previous.length} last time; kept the last good rows`,
      };
    }
    if (read.ok) {
      rows.push(...read.rows);
      results.push({ source: read.source, ok: true, rows: read.rows.length, unmapped: read.unmapped });
    } else {
      rows.push(...previous.map((r) => ({ ...r, stale: true })));
      results.push({ source: read.source, ok: false, rows: previous.length, unmapped: 0, error: read.error });
    }
  }

  const merged = mergeRows(rows);
  const failed = results.filter((r) => !r.ok);
  const snapshotId = await writeSnapshot(db, {
    takenAt: now.toISOString(),
    status: failed.length ? "partial" : "good",
    results,
    rows: merged.rows,
  });
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
