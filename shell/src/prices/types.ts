// One price row: one provider, one model, one deployment type and region, and
// one kind of token, in USD per million tokens (design-v3 1.3).

export type Provider = "foundry" | "bedrock" | "vertex";

export type TokenKind =
  | "input"
  | "cached_input"
  | "cache_write"
  | "cache_write_1h"
  | "output";

export type Deployment = "global" | "data-zone" | "regional" | "cross-region";

export type SourceId =
  | "azure-retail"
  | "aws-price-list"
  | "google-catalog"
  | "maintainer-read";

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
export type SourceRead =
  | { source: SourceId; ok: true; rows: PriceRow[]; unmapped: number }
  | { source: SourceId; ok: false; error: string };

export interface SourceResult {
  source: SourceId;
  ok: boolean;
  rows: number;
  unmapped: number;
  error?: string;
}

export const rowKey = (r: PriceRow): string =>
  [r.provider, r.model, r.deployment, r.region, r.tokenKind, r.longPrompt ? 1 : 0, r.batch ? 1 : 0].join("|");
