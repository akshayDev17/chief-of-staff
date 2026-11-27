// A router's price cap (the owner, 2026-11-28: "why are openrouter
// unchoosable and how to choose them? wont my base tier users of COS wanna
// know this and make it happen in as few and obvious clicks as possible?").
//
//   readPriceCaps(db, userId, provider) -> Map<model, PriceCap>
//   readPriceCap(db, userId, provider, model) -> PriceCap | undefined
//   savePriceCap(db, userId, provider, model, cap, now)
//   parsePriceCap(input, output) -> PriceCap | undefined
//
// A router such as `openrouter/auto` is priced by the model it picks for each
// call (`pricing.prompt` "-1"), so the budget stop has no price for it. The
// cap is one: in USD per million input and output tokens, and every call to
// the router carries it as OpenRouter's `provider.max_price` ("The maximum
// pricing you want to pay for this request. USD price per million tokens, for
// prompt and completion", OpenRouter's live OpenAPI spec, ProviderPreferences,
// read 2026-11-28; the Auto Router "filters the endpoints of whichever models
// the router resolves" by it, https://openrouter.ai/docs/features/model-routing,
// read 2026-11-28). The proxy prices the call at the cap when OpenRouter's
// reply reports no cost (src/proxy/proxy.ts).

import type { Provider } from "../prices/types";

export interface PriceCap {
  // USD per million tokens.
  input: number;
  output: number;
  setAt?: string;
}

// The cap shown first in the editor: a strong model's price, so most routed
// models fit under it.
export const DEFAULT_CAP: PriceCap = { input: 3, output: 15 };

// A cap above this many dollars per million tokens is a typo, not a cap.
export const MAX_CAP_USD = 1000;

export async function readPriceCaps(db: D1Database, userId: string, provider: Provider): Promise<Map<string, PriceCap>> {
  const { results } = await db
    .prepare("SELECT model, input_usd_per_mtok, output_usd_per_mtok, set_at FROM model_price_caps WHERE user_id = ? AND provider = ?")
    .bind(userId, provider)
    .all<{ model: string; input_usd_per_mtok: number; output_usd_per_mtok: number; set_at: string }>();
  return new Map(results.map((r) => [r.model, { input: r.input_usd_per_mtok, output: r.output_usd_per_mtok, setAt: r.set_at }]));
}

export async function readPriceCap(db: D1Database, userId: string, provider: Provider, model: string): Promise<PriceCap | undefined> {
  const r = await db
    .prepare("SELECT input_usd_per_mtok, output_usd_per_mtok, set_at FROM model_price_caps WHERE user_id = ? AND provider = ? AND model = ?")
    .bind(userId, provider, model)
    .first<{ input_usd_per_mtok: number; output_usd_per_mtok: number; set_at: string }>();
  return r ? { input: r.input_usd_per_mtok, output: r.output_usd_per_mtok, setAt: r.set_at } : undefined;
}

export async function savePriceCap(db: D1Database, userId: string, provider: Provider, model: string, cap: PriceCap, now: Date): Promise<void> {
  await db
    .prepare(
      `INSERT INTO model_price_caps (user_id, provider, model, input_usd_per_mtok, output_usd_per_mtok, set_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (user_id, provider, model) DO UPDATE SET input_usd_per_mtok = excluded.input_usd_per_mtok,
         output_usd_per_mtok = excluded.output_usd_per_mtok, set_at = excluded.set_at`,
    )
    .bind(userId, provider, model, cap.input, cap.output, now.toISOString())
    .run();
}

// Two prices as typed ("3", "$3.00", "15"), or undefined unless both are
// above 0 and at most MAX_CAP_USD.
export function parsePriceCap(input: string, output: string): PriceCap | undefined {
  const usd = (text: string): number | undefined => {
    const n = Number(text.trim().replace(/^\$/, "").replace(/,/g, ""));
    return text.trim() !== "" && Number.isFinite(n) && n > 0 && n <= MAX_CAP_USD ? Math.round(n * 1_000_000) / 1_000_000 : undefined;
  };
  const i = usd(input);
  const o = usd(output);
  return i !== undefined && o !== undefined ? { input: i, output: o } : undefined;
}
