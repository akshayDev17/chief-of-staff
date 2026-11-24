// The usage ledger (design-v3 1.7, Record A): one D1 row for every call the
// proxy sends to a provider, tagged with the user. Never a prompt or a reply.

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
  outputTokens: number;
  durationMs: number;
  costUsd: number;
}

export async function writeLedgerRow(db: D1Database, r: LedgerRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO model_calls (user_id, at, task, site, company, run_id, provider, model, region, tier, plugin_version, status,
         fallback, fallback_reason, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, duration_ms, cost_usd)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`,
    )
    .bind(
      r.userId, r.at.toISOString(), r.task, r.site, r.company ?? null, r.runId ?? null, r.provider, r.model, r.region,
      r.tier ?? null, r.pluginVersion, r.status, r.fallbackReason ? 1 : 0, r.fallbackReason ?? null, r.inputTokens,
      r.cachedInputTokens, r.cacheWriteTokens, r.outputTokens, r.durationMs, r.costUsd,
    )
    .run();
}

// Months run in UTC: spend counts from 00:00 UTC on the 1st.
export const monthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
export const nextMonthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

// The user's spend at one provider since the 1st, at the list prices each
// call was costed at.
export async function monthSpend(db: D1Database, userId: string, provider: string, now: Date): Promise<number> {
  const row = await db
    .prepare("SELECT coalesce(sum(cost_usd), 0) AS spent FROM model_calls WHERE user_id = ? AND provider = ? AND at >= ?")
    .bind(userId, provider, monthStart(now).toISOString())
    .first<{ spent: number }>();
  return row?.spent ?? 0;
}
