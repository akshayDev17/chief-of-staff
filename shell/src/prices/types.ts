// One price row: one provider, one model, one deployment type and region, and
// one kind of token, in USD per million tokens (design-v3 1.3).

export type Provider = "openrouter";

export const PROVIDERS: readonly Provider[] = ["openrouter"];

export const isProvider = (value: string): value is Provider => (PROVIDERS as readonly string[]).includes(value);

export type TokenKind =
  | "input"
  | "cached_input"
  | "cache_write"
  | "cache_write_1h"
  | "output"
  // The provider's fee per call; its row's usdPerMTok is USD per million calls.
  | "request";

// OpenRouter routes each call itself, so every row is `global`.
export type Deployment = "global";

export type SourceId = "openrouter-models";

export interface PriceRow {
  provider: Provider;
  model: string;
  deployment: Deployment;
  region: string;
  tokenKind: TokenKind;
  longPrompt: boolean;
  batch: boolean;
  usdPerMTok: number;
  source: SourceId;
  dateRead: string; // YYYY-MM-DD
  stale: boolean;
  disagreement: boolean;
}

// What one source's read produced: rows, or a failure with its reason.
// `unmapped` counts the entries the source listed that are not rows (for
// OpenRouter, the models that are not chat models it sells).
export type SourceRead =
  | { source: SourceId; ok: true; rows: PriceRow[]; unmapped: number }
  | { source: SourceId; ok: false; error: string };

export interface SourceResult {
  source: SourceId;
  ok: boolean;
  rows: number;
  unmapped: number;
  // Rows of this source in the snapshot that the previous snapshot did not
  // have, and rows it had that this one does not.
  added: number;
  dropped: number;
  error?: string;
}

export const rowKey = (r: PriceRow): string =>
  [r.provider, r.model, r.deployment, r.region, r.tokenKind, r.longPrompt ? 1 : 0, r.batch ? 1 : 0].join("|");
