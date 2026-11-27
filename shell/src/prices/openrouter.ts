// OpenRouter's own model list and prices (design-v3 1.3): the price table's
// one source, read by the daily refresh and by Refresh model list.
//
//   readOpenRouter(fetcher, now) -> { read: SourceRead, catalog?: OpenRouterCatalog }
//
// From OpenRouter's models API (https://openrouter.ai/docs/api-reference/list-available-models,
// and https://openrouter.ai/docs/guides/overview/models, read 2026-11-27, no
// page dates): `GET https://openrouter.ai/api/v1/models` needs no key, and
// "All pricing values are in USD per token/request/unit. A value of "0"
// indicates the feature is free"; routers such as `openrouter/auto` "set
// `pricing.prompt: "-1"`", their cost depending on the model they pick; the
// model's `pricing` is "Pricing from the top provider for this model".
//
// Every model the API lists is kept in the model list (the owner,
// 2026-11-27: "i would like to list all models and then choose"). It can be
// chosen when it takes text and gives text, with a prompt and a completion
// price that are numbers (a free `:free` model at $0 included). The others
// are listed with the reason they cannot be: a router (`-1`), priced by the
// model it picks for each call, so the budget stop has no price; a `~…`
// alias, which OpenRouter moves to the newest model of a line (that model is
// listed under its own ID, and a reply names it, not the alias); a model that
// takes or gives no text. Only models that can be chosen get price rows.
//
// The list is OpenRouter's public list: the same for every account, and read
// with no key. Whether a model answers for one user's account (their
// credits, their OpenRouter privacy and provider settings) shows only when
// it is tested (Choose, or Test all models).
//
// Each model's rows: `prompt` is input, `completion` output,
// `input_cache_read` cached input, `input_cache_write` a cache write,
// `input_cache_write_1h` a 1-hour cache write and `request` the fee per call
// (kept as USD per million calls). A reply counts reasoning tokens within its
// completion tokens, so a model whose `internal_reasoning` rate is dearer
// than `completion` has its output row at the reasoning rate: a call priced
// from the table never counts its reasoning below OpenRouter's rate. A model can carry `overrides`:
// higher prices above a prompt length (`min_prompt_tokens`), and prices by
// time of day. The standard rows take the dearest of the base price and each
// time-of-day price, and the long-prompt rows the dearest of the prompt-length
// prices, so a call priced from the table (when OpenRouter's reply reports no
// cost, src/proxy/proxy.ts) never counts less than OpenRouter can charge.

import { OPENROUTER_MODELS_URL } from "./sources";
import type { PriceRow, SourceRead, TokenKind } from "./types";

export interface OpenRouterModel {
  id: string;
  name: string;
  // Why the app cannot call it, in plain words; absent when it can.
  blocked?: string;
  // OpenRouter lists `tools` among its supported parameters.
  tools: boolean;
  // The date OpenRouter retires it (YYYY-MM-DD), when it names one.
  expires?: string;
  // The smallest prompt length at which a higher price applies, when any.
  longPromptFrom?: number;
}

export interface OpenRouterCatalog {
  readAt: string;
  models: OpenRouterModel[];
}

interface Listed {
  id?: unknown;
  name?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  pricing?: Record<string, unknown>;
  supported_parameters?: unknown;
  expiration_date?: unknown;
}

const PRICE_FIELDS: ReadonlyArray<readonly [string, TokenKind]> = [
  ["prompt", "input"],
  ["completion", "output"],
  ["input_cache_read", "cached_input"],
  ["input_cache_write", "cache_write"],
  ["input_cache_write_1h", "cache_write_1h"],
  ["request", "request"],
];

// A per-token price string as USD per million tokens; undefined unless it is
// a number of zero or more.
export function perMillion(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (typeof value === "string" && value.trim() === "")) return undefined;
  return Number((n * 1_000_000).toPrecision(12));
}

const includesText = (modalities: unknown): boolean => Array.isArray(modalities) && modalities.includes("text");

// Why the app cannot call a listed model, or undefined when it can.
export function blockedReason(m: Listed): string | undefined {
  if (typeof m.id === "string" && m.id.startsWith("~")) return "an alias OpenRouter moves to the newest model of its line: choose that model by its own ID";
  if (!includesText(m.architecture?.input_modalities) || !includesText(m.architecture?.output_modalities)) return "it takes or gives no text, and every task sends and reads text";
  if (String(m.pricing?.prompt ?? "").trim().startsWith("-")) return "OpenRouter prices it by the model it picks for each call, so the budget stop has no price";
  if (perMillion(m.pricing?.prompt) === undefined || perMillion(m.pricing?.completion) === undefined) return "OpenRouter lists no price for it, and the budget stop needs a real price";
  return undefined;
}

type Prices = Partial<Record<TokenKind, number>>;

const pricesOf = (pricing: Record<string, unknown>): Prices => {
  const out: Prices = {};
  for (const [field, kind] of PRICE_FIELDS) {
    const usd = perMillion(pricing[field]);
    if (usd !== undefined) out[kind] = usd;
  }
  const reasoning = perMillion(pricing.internal_reasoning);
  if (reasoning !== undefined && out.output !== undefined) out.output = Math.max(out.output, reasoning);
  return out;
};

const dearest = (into: Prices, from: Prices): Prices => {
  const out = { ...into };
  for (const [kind, usd] of Object.entries(from) as Array<[TokenKind, number]>) out[kind] = Math.max(out[kind] ?? 0, usd);
  return out;
};

const overridesOf = (pricing: Record<string, unknown>): Array<Record<string, unknown>> =>
  Array.isArray(pricing.overrides) ? pricing.overrides.filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object") : [];

const minPromptTokens = (o: Record<string, unknown>): number | undefined =>
  typeof o.min_prompt_tokens === "number" && o.min_prompt_tokens > 0 ? o.min_prompt_tokens : undefined;

// The standard and long-prompt prices of one chat model, each kind at the
// dearest price OpenRouter lists for it at that tier.
export function modelPrices(pricing: Record<string, unknown>): { standard: Prices; long: Prices; longPromptFrom?: number } {
  let standard = pricesOf(pricing);
  let long: Prices = {};
  let longPromptFrom: number | undefined;
  for (const o of overridesOf(pricing)) {
    const from = minPromptTokens(o);
    if (from === undefined) {
      standard = dearest(standard, pricesOf(o));
    } else {
      long = dearest(long, pricesOf(o));
      longPromptFrom = Math.min(longPromptFrom ?? from, from);
    }
  }
  return { standard, long, longPromptFrom };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// `leftOut`: the listed models that cannot be chosen, so have no rows.
export function parseModels(body: unknown, now: Date): { rows: PriceRow[]; catalog: OpenRouterCatalog; leftOut: number } {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("the models API answered without a `data` list");
  const dateRead = now.toISOString().slice(0, 10);
  const rows: PriceRow[] = [];
  const models: OpenRouterModel[] = [];
  let leftOut = 0;
  const seen = new Set<string>();
  for (const m of data as Listed[]) {
    if (typeof m.id !== "string" || !m.id || seen.has(m.id)) continue;
    const id = m.id;
    seen.add(id);
    const name = typeof m.name === "string" && m.name ? m.name : id;
    const blocked = blockedReason(m);
    if (blocked) {
      leftOut++;
      models.push({ id, name, blocked, tools: false });
      continue;
    }
    const { standard, long, longPromptFrom } = modelPrices(m.pricing ?? {});
    const row = (tokenKind: TokenKind, usdPerMTok: number, longPrompt: boolean): PriceRow => ({
      provider: "openrouter", model: id, deployment: "global", region: "global", tokenKind, longPrompt, batch: false, usdPerMTok,
      source: "openrouter-models", dateRead, stale: false, disagreement: false,
    });
    for (const [kind, usd] of Object.entries(standard) as Array<[TokenKind, number]>) rows.push(row(kind, usd, false));
    for (const [kind, usd] of Object.entries(long) as Array<[TokenKind, number]>) rows.push(row(kind, usd, true));
    const expires = typeof m.expiration_date === "string" && DATE.test(m.expiration_date) ? m.expiration_date : undefined;
    models.push({
      id,
      name,
      tools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"),
      ...(expires ? { expires } : {}),
      ...(longPromptFrom ? { longPromptFrom } : {}),
    });
  }
  if (!rows.length) throw new Error("the models API listed no model the app can call");
  models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { rows, catalog: { readAt: now.toISOString(), models }, leftOut };
}

export async function readOpenRouter(fetcher: typeof fetch, now: Date): Promise<{ read: SourceRead; catalog?: OpenRouterCatalog }> {
  try {
    const response = await fetcher(OPENROUTER_MODELS_URL, { headers: { accept: "application/json" } });
    if (!response.ok) return { read: { source: "openrouter-models", ok: false, error: `HTTP ${response.status}` } };
    const { rows, catalog, leftOut } = parseModels(await response.json(), now);
    return { read: { source: "openrouter-models", ok: true, rows, unmapped: leftOut }, catalog };
  } catch (error) {
    return { read: { source: "openrouter-models", ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}
