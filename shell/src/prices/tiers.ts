// A model's tier is worked out from its input list price per 1M tokens, never
// set by hand (the owner, 2026-11-24; bands from the price report of that day).
//
// One tier per model at each provider, from its standard input price (not a
// long-prompt or batch one): the highest such price the table lists for the
// model, so the tier never rests on a price lower than the provider can
// charge. Every row of the model carries that tier.

import type { PriceRow, Provider } from "./types";

export type Tier = "Smallest" | "Middle" | "Strongest";

export const tierFromInputPrice = (usdPerMTok: number): Tier =>
  usdPerMTok < 0.5 ? "Smallest" : usdPerMTok < 2.5 ? "Middle" : "Strongest";

// `rows` are one provider's rows for one model; undefined when none of them
// is a standard input price.
export function modelTier(provider: Provider, rows: PriceRow[]): Tier | undefined {
  const inputs = rows.filter((r) => r.provider === provider && r.tokenKind === "input" && !r.longPrompt && !r.batch).map((r) => r.usdPerMTok);
  return inputs.length ? tierFromInputPrice(Math.max(...inputs)) : undefined;
}

export const tierKey = (provider: Provider, model: string): string => `${provider}|${model}`;

// Every model's tier in a set of rows, keyed by tierKey.
export function modelTiers(rows: PriceRow[]): Map<string, Tier> {
  const byModel = new Map<string, PriceRow[]>();
  for (const r of rows) {
    const key = tierKey(r.provider, r.model);
    const seen = byModel.get(key);
    if (seen) seen.push(r);
    else byModel.set(key, [r]);
  }
  const tiers = new Map<string, Tier>();
  for (const [key, modelRows] of byModel) {
    const tier = modelTier(modelRows[0]!.provider, modelRows);
    if (tier) tiers.set(key, tier);
  }
  return tiers;
}
