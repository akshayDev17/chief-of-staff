// A model's tier is worked out from its input list price per 1M tokens, never
// set by hand (the owner, 2026-11-24; bands from the price report of that day).
//
// One tier per model at each provider, from its input price where the app runs
// it by default (design-v3 1.2, decision 5): Global on Foundry and Bedrock where
// the model is offered there, a specific region on Vertex AI. The first
// deployment type below that prices the model gives its input price; within
// it, the highest price, so the tier never rests on a price lower than the
// vendor can charge there. Every other row of the model carries that tier.

import type { Deployment, PriceRow, Provider } from "./types";

export type Tier = "Smallest" | "Middle" | "Strongest";

export const tierFromInputPrice = (usdPerMTok: number): Tier =>
  usdPerMTok < 0.5 ? "Smallest" : usdPerMTok < 2.5 ? "Middle" : "Strongest";

export const TIER_DEPLOYMENTS: Record<Provider, readonly Deployment[]> = {
  foundry: ["global", "data-zone", "regional"],
  bedrock: ["global", "cross-region", "regional"],
  vertex: ["regional", "global"],
};

// `rows` are one provider's rows for one model; undefined when none of them
// is a standard input price.
export function modelTier(provider: Provider, rows: PriceRow[]): Tier | undefined {
  const inputs = rows.filter((r) => r.provider === provider && r.tokenKind === "input" && !r.longPrompt && !r.batch);
  for (const deployment of TIER_DEPLOYMENTS[provider]) {
    const prices = inputs.filter((r) => r.deployment === deployment).map((r) => r.usdPerMTok);
    if (prices.length) return tierFromInputPrice(Math.max(...prices));
  }
  return undefined;
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
