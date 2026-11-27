// Models › Usage's figures (design-v3 10.1: "model spend this month against
// the budget, ... and per model and per task, from the usage ledger"). One
// read of the ledger (model_calls, design-v3 1.7) for the user's OpenRouter
// calls since 00:00 UTC on the 1st, grouped by model and by task, and summed
// three ways from those same groups: per model, per task and the month's
// total, so the three always add up to one another.
//
//   readMonthUsage(db, userId, now, keySince?) -> MonthUsage
//   summariseUsage(groups) -> { total, byModel, byTask, beforeKeyUsd }
//
// Each call's cost is the ledger's own: OpenRouter's reported cost from its
// reply (`cost_source` 'reported'), or, when the reply reported none, the
// model's list price from the price table ('list_price'). That second kind is
// an estimate, and so is a row written before the ledger recorded how it was
// costed (`cost_source` NULL, from the release before 0012), which the proxy
// of the time priced from the price table. Each sum carries how much of it is
// estimated, so the page can say so beside the figure.
//
// The ledger does not record which OpenRouter key made a call, but each
// Connect makes a new key and writes the connection then (connected_at), so
// a call made this month before that time was made with an earlier key.
// Given that time, the same read sums those calls' cost (beforeKeyUsd): the
// part of the app's count that OpenRouter's figure for the current key
// cannot include.

import { monthStart } from "../proxy/ledger";

// The sums for one model, one task, or the whole month.
export interface UsageLine {
  // The model's OpenRouter ID, or the task's ID; "" for the month's total.
  key: string;
  calls: number;
  // Calls OpenRouter refused or failed (any status outside 2xx).
  refused: number;
  // Every input token (uncached, cached and cache writes) and every output token.
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  // The part of costUsd costed at list price, not reported by OpenRouter.
  estimatedUsd: number;
}

// One ledger group: the sums for one model and one task.
export interface UsageGroup {
  model: string;
  task: string;
  calls: number;
  refused: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  estimatedUsd: number;
  // The part of costUsd from calls made before the current key (see above).
  beforeKeyUsd?: number;
}

export interface MonthUsage {
  // 00:00 UTC on the 1st, ISO 8601.
  since: string;
  total: UsageLine;
  byModel: UsageLine[];
  byTask: UsageLine[];
  // This month's cost of calls made before the current key, 0 without one.
  beforeKeyUsd: number;
}

const empty = (key: string): UsageLine => ({ key, calls: 0, refused: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, estimatedUsd: 0 });

function add(into: UsageLine, g: UsageGroup): void {
  into.calls += g.calls;
  into.refused += g.refused;
  into.inputTokens += g.inputTokens;
  into.outputTokens += g.outputTokens;
  into.costUsd += g.costUsd;
  into.estimatedUsd += g.estimatedUsd;
}

// Per model, per task and in total, from the same groups. Lines come in the
// order of their keys; the page sorts them.
export function summariseUsage(groups: UsageGroup[]): Omit<MonthUsage, "since"> {
  const total = empty("");
  let beforeKeyUsd = 0;
  const byModel = new Map<string, UsageLine>();
  const byTask = new Map<string, UsageLine>();
  for (const g of groups) {
    add(total, g);
    beforeKeyUsd += g.beforeKeyUsd ?? 0;
    add(byModel.get(g.model) ?? byModel.set(g.model, empty(g.model)).get(g.model)!, g);
    add(byTask.get(g.task) ?? byTask.set(g.task, empty(g.task)).get(g.task)!, g);
  }
  const ordered = (m: Map<string, UsageLine>) => [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
  return { total, byModel: ordered(byModel), byTask: ordered(byTask), beforeKeyUsd };
}

// The user's OpenRouter calls this month, from the ledger. The same rows the
// proxy's budget check sums (ledger.ts monthSpend), so the total is the
// app's own count that stops calls. `keySince` is when the current key was
// made (the connection's connected_at), when there is one.
export async function readMonthUsage(db: D1Database, userId: string, now: Date, keySince?: Date): Promise<MonthUsage> {
  const since = monthStart(now).toISOString();
  const { results } = await db
    .prepare(
      `SELECT model, task, count(*) AS calls,
         sum(CASE WHEN status BETWEEN 200 AND 299 THEN 0 ELSE 1 END) AS refused,
         sum(input_tokens + cached_input_tokens + cache_write_tokens + cache_write_1h_tokens) AS inputTokens,
         sum(output_tokens) AS outputTokens,
         sum(cost_usd) AS costUsd,
         sum(CASE WHEN cost_source = 'reported' THEN 0 ELSE cost_usd END) AS estimatedUsd,
         sum(CASE WHEN at < ?1 THEN cost_usd ELSE 0 END) AS beforeKeyUsd
       FROM model_calls WHERE user_id = ?2 AND provider = 'openrouter' AND at >= ?3
       GROUP BY model, task`,
    )
    .bind(keySince?.toISOString() ?? "", userId, since)
    .all<UsageGroup>();
  return { since, ...summariseUsage(results) };
}
