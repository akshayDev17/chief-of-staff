// The price lookup the proxy (T12) calls before every model call.
//
//   lookupPrice(db, { provider, model, location, tokenKind, longPrompt?, batch? })
//     -> { usdPerMTok, source, dateRead, stale } | undefined
//
// `location` is the request's region or deployment type: `global` for every
// OpenRouter model, which OpenRouter routes itself. `undefined` means "no
// price yet": the proxy refuses the call and the picker (T17) cannot offer
// the model, because the budget stop needs a real price. Prices come from the current snapshot only.
//
//   lookupTier(db, { provider, model }) -> "Smallest" | "Middle" | "Strongest" | undefined
//
// The model's one tier at that provider, as the model list (T17), the
// per-task picker (T18) and the usage ledger (T12) show it: strength.ts reads
// it, by the rule in tiers.ts.

import { readModelStrength } from "./strength";
import { currentSnapshot, readRow } from "./store";
import type { Tier } from "./tiers";
import type { Provider, SourceId, TokenKind } from "./types";

export interface PriceQuery {
  provider: Provider;
  model: string;
  location: string;
  tokenKind: TokenKind;
  longPrompt?: boolean;
  batch?: boolean;
}

export interface PriceAnswer {
  usdPerMTok: number;
  source: SourceId;
  dateRead: string;
  stale: boolean;
}

export async function lookupPrice(db: D1Database, q: PriceQuery): Promise<PriceAnswer | undefined> {
  const snapshot = await currentSnapshot(db);
  if (!snapshot) return undefined;
  const row = await readRow(db, snapshot.id, {
    provider: q.provider,
    model: q.model,
    location: q.location,
    tokenKind: q.tokenKind,
    longPrompt: q.longPrompt ?? false,
    batch: q.batch ?? false,
  });
  return row ? { usdPerMTok: row.usdPerMTok, source: row.source, dateRead: row.dateRead, stale: row.stale } : undefined;
}

export async function lookupTier(db: D1Database, q: { provider: Provider; model: string }): Promise<Tier | undefined> {
  return (await readModelStrength(db, q)).tier;
}
