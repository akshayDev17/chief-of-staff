// Rows read by the maintainers: models no automatic source covers (on
// 2026-11-23, Foundry's Claude). The file is shell/prices/maintainer-read.json,
// changed only through a reviewed pull request. An entry without its listing
// address or its date read is refused, here and so in CI, as is any field the
// table needs that is missing or not one the table knows.

import type { PriceRow, TokenKind } from "./types";

export interface MaintainerEntry {
  model: string;
  deployment: "global" | "data-zone" | "regional";
  region: string;
  plan: string;
  listing: string;
  read_via?: string;
  date_read: string;
  meters: Array<{ token_kind: TokenKind; long_prompt: boolean; usd_per_mtok: number }>;
}

const TOKEN_KINDS: readonly unknown[] = ["input", "cached_input", "cache_write", "cache_write_1h", "output"];
const DEPLOYMENTS: readonly unknown[] = ["global", "data-zone", "regional"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Returns the problems with the file; an empty list means every entry is valid.
export function checkMaintainerEntries(entries: unknown): string[] {
  if (!Array.isArray(entries)) return ["entries is not a list"];
  const problems: string[] = [];
  entries.forEach((e: Partial<MaintainerEntry>, i) => {
    const at = `entry ${i} (${e?.model ?? "no model"})`;
    if (!e || typeof e.model !== "string" || !e.model) problems.push(`${at}: no model`);
    if (typeof e?.listing !== "string" || !/^https:\/\/\S+$/.test(e.listing)) problems.push(`${at}: no listing address`);
    if (typeof e?.date_read !== "string" || !DATE.test(e.date_read) || Number.isNaN(Date.parse(e.date_read)))
      problems.push(`${at}: no date read`);
    if (!DEPLOYMENTS.includes(e?.deployment)) problems.push(`${at}: unknown deployment ${e?.deployment}`);
    if (typeof e?.region !== "string" || !e.region) problems.push(`${at}: no region`);
    if (!Array.isArray(e?.meters) || e.meters.length === 0) problems.push(`${at}: no meters`);
    const meters = new Set<string>();
    for (const m of Array.isArray(e?.meters) ? e.meters : []) {
      if (!TOKEN_KINDS.includes(m?.token_kind)) problems.push(`${at}: unknown token kind ${m?.token_kind}`);
      if (typeof m?.long_prompt !== "boolean") problems.push(`${at}: long_prompt is not true or false`);
      if (typeof m?.usd_per_mtok !== "number" || !(m.usd_per_mtok >= 0)) problems.push(`${at}: bad price`);
      const meter = `${m?.token_kind} ${m?.long_prompt ? "long prompt" : "standard"}`;
      if (meters.has(meter)) problems.push(`${at}: two ${meter} meters`);
      meters.add(meter);
    }
  });
  return problems;
}

export function rowsFromMaintainerEntries(entries: MaintainerEntry[]): PriceRow[] {
  return entries.flatMap((e) =>
    e.meters.map((m) => ({
      provider: "foundry" as const,
      model: e.model,
      deployment: e.deployment,
      region: e.region,
      tokenKind: m.token_kind,
      longPrompt: m.long_prompt,
      batch: false,
      usdPerMTok: m.usd_per_mtok,
      source: "maintainer-read" as const,
      dateRead: e.date_read,
      stale: false,
      disagreement: false,
    })),
  );
}

// Entries whose reading is more than a week old on `today` (YYYY-MM-DD).
export function entriesDueForReading(entries: MaintainerEntry[], today: string): MaintainerEntry[] {
  const weekAgo = Date.parse(today) - 7 * 86_400_000;
  return entries.filter((e) => Date.parse(e.date_read) < weekAgo);
}
