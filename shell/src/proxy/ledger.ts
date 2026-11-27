// The usage ledger (design-v3 1.7, Record A): one D1 row for every call the
// proxy sends to a provider, tagged with the user. Never a prompt or a reply.

import type { TokenKind } from "../prices/types";

export interface LedgerRow {
  userId: string;
  at: Date;
  task: string;
  site: string;
  company?: string;
  runId?: string;
  provider: string;
  model: string;
  region: string;
  tier?: string;
  pluginVersion: string;
  status: number;
  fallbackReason?: "refused" | "budget_spent";
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  longPrompt: boolean;
  durationMs: number;
  costUsd: number;
  // How the cost was worked out: the provider's reported cost, or list prices.
  costSource: "reported" | "list_price";
  // The provider's own ID for the call (OpenRouter's generation ID).
  providerCallId?: string;
  // Each kind costed above its own list price, which the table lacks, and
  // the rate used (proxy.ts costOf); empty when every kind had its own row.
  costedConservatively: Partial<Record<TokenKind, number>>;
}

export async function writeLedgerRow(db: D1Database, r: LedgerRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO model_calls (user_id, at, task, site, company, run_id, provider, model, region, tier, plugin_version, status,
         fallback, fallback_reason, input_tokens, cached_input_tokens, cache_write_tokens, cache_write_1h_tokens, output_tokens,
         long_prompt, duration_ms, cost_usd, costed_conservatively, cost_source, provider_call_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)`,
    )
    .bind(
      r.userId, r.at.toISOString(), r.task, r.site, r.company ?? null, r.runId ?? null, r.provider, r.model, r.region,
      r.tier ?? null, r.pluginVersion, r.status, r.fallbackReason ? 1 : 0, r.fallbackReason ?? null, r.inputTokens,
      r.cachedInputTokens, r.cacheWriteTokens, r.cacheWrite1hTokens, r.outputTokens, r.longPrompt ? 1 : 0, r.durationMs,
      r.costUsd, Object.keys(r.costedConservatively).length ? JSON.stringify(r.costedConservatively) : null, r.costSource,
      r.providerCallId ?? null,
    )
    .run();
}

// Months run in UTC: spend counts from 00:00 UTC on the 1st.
export const monthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
export const nextMonthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

// The user's spend at one provider since the 1st, as each call was costed
// (the provider's reported cost, or list prices).
export async function monthSpend(db: D1Database, userId: string, provider: string, now: Date): Promise<number> {
  const row = await db
    .prepare("SELECT coalesce(sum(cost_usd), 0) AS spent FROM model_calls WHERE user_id = ? AND provider = ? AND at >= ?")
    .bind(userId, provider, monthStart(now).toISOString())
    .first<{ spent: number }>();
  return row?.spent ?? 0;
}
