// The price lookup the proxy (T12) calls before every model call.
//
//   lookupPrice(db, { provider, model, location, tokenKind, longPrompt?, batch? })
//     -> { usdPerMTok, source, dateRead, stale } | undefined
//
// `location` is the request's region ("us-east-1", "eastus2") or deployment
// type ("global", "data-zone"). `undefined` means "no price yet": the proxy
// refuses the call and the picker (T17) cannot offer the model, because the
// budget stop needs a real price. Prices come from the current snapshot only.

import { currentSnapshot, readRow } from "./store";
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
