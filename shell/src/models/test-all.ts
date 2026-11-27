// Test all models (the owner, 2026-11-27: "post-connection testing just to
// let a COS user see that w.r.t. that provider what all models work and what
// arent at the moment"): one test call on every model the user can choose at
// a connected provider, billed to the user's own account, so it shows the
// estimated total cost before it runs.
//
//   planTestAll(db, plugins, userId, provider, now) -> TestAllPlan   the models, the estimate, whether it may start
//   startTestAll(db, plugins, userId, provider, now)                 queues one test per model
//   runQueuedTests(db, plugins, now)                                 the every-minute cron, a few at a time
//   readTestAll(db, userId, provider) -> TestAllRun | undefined      the latest run and its results
//
// Each test is the model's own test call (models/add.ts testModel) through
// the proxy, which prices it and writes its ledger row under the task
// `test_all_models`. Its reply is capped at 16 tokens; a 200 with no text (a
// reasoning model that spent them thinking) counts as working. A model that
// works is added to the user's models, as choosing it does, so it is offered
// for tasks; one that does not work now is not taken out of them (a busy
// minute is not a lost model). The estimate is the models' list prices for
// the test's tokens: at most ESTIMATE_INPUT_TOKENS in and the 16-token cap
// out. The real total is the sum of the run's ledger rows: the cost
// OpenRouter reported for each call.
//
// Limits: one run at a time per user and provider, a new one at most every
// RUN_GAP_MINUTES, and the cron runs at most PER_TICK tests a minute across
// every user, CONCURRENCY at once, so a run of ~460 models takes about ten
// minutes and stays inside the Worker's per-invocation limits.

import { TEST_MAX_TOKENS } from "../providers/openrouter";
import { readCurrentCatalog } from "../prices/store";
import type { Provider } from "../prices/types";
import { readConnection } from "../proxy/connections";
import type { PluginRegistry } from "../proxy/plugin";
import { blockedReason, listOffer, refusalText, saveUserModel, testModel, type AddRefusal, type OfferRow } from "./add";

export const TEST_ALL_TASK = "test_all_models";
export const RUN_GAP_MINUTES = 10;
export const PER_TICK = 50;
export const CONCURRENCY = 5;
// The test prompt ("Reply with the single word OK.") with a chat template's
// own tokens around it, rounded well up.
export const ESTIMATE_INPUT_TOKENS = 40;

export interface TestAllPlan {
  models: Array<{ model: string; location: string; estimateUsd: number }>;
  estimateUsd: number;
  // Why a run cannot start now, if it cannot.
  wait?: string;
}

export interface ModelTestRow {
  model: string;
  state: "queued" | "passed" | "failed";
  // The plain reason and the provider's own words, for a failure; the reply
  // text, for a pass.
  result?: { reason?: AddRefusal; text: string; reply?: { status: number; errorName?: string; message?: string }; replyText?: string };
  costUsd?: number;
  testedAt?: string;
}

export interface TestAllRun {
  id: number;
  startedAt: string;
  finishedAt?: string;
  modelCount: number;
  estimateUsd: number;
  tests: ModelTestRow[];
  done: number;
  // The sum of the run's ledger rows: the cost the provider reported.
  realCostUsd: number;
}

const minutesAfter = (iso: string, minutes: number): Date => new Date(Date.parse(iso) + minutes * 60_000);
const hhmm = (d: Date): string => `${d.toISOString().slice(11, 16)} UTC`;

interface RunRecord {
  id: number;
  started_at: string;
  finished_at: string | null;
  model_count: number;
  estimate_usd: number;
}

async function latestRun(db: D1Database, userId: string, provider: Provider): Promise<RunRecord | undefined> {
  return (
    (await db
      .prepare("SELECT id, started_at, finished_at, model_count, estimate_usd FROM model_test_runs WHERE user_id = ? AND provider = ? ORDER BY id DESC LIMIT 1")
      .bind(userId, provider)
      .first<RunRecord>()) ?? undefined
  );
}

// `offers`: the model list, when the caller has read it already.
export async function planTestAll(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider, now: Date, offers?: OfferRow[]): Promise<TestAllPlan> {
  const plugin = plugins[provider];
  if (!plugin) return { models: [], estimateUsd: 0, wait: "That provider is not offered." };
  offers ??= await listOffer(db, plugins, userId, provider);
  const models = offers.flatMap((r) =>
    !blockedReason(r, plugin) && r.price
      ? [{ model: r.model, location: r.location, estimateUsd: (ESTIMATE_INPUT_TOKENS * r.price.input + TEST_MAX_TOKENS * r.price.output) / 1_000_000 }]
      : [],
  );
  const estimateUsd = models.reduce((sum, m) => sum + m.estimateUsd, 0);
  const last = await latestRun(db, userId, provider);
  let wait: string | undefined;
  if (!(await readConnection(db, userId, provider))) wait = `${plugin.connect.guide.name} is not connected.`;
  else if (!models.length) wait = "No model can be tested yet: the price table has none.";
  else if (last && !last.finished_at) wait = "A test of all models is running already.";
  else if (last && minutesAfter(last.started_at, RUN_GAP_MINUTES) > now) wait = `You can test all models again from ${hhmm(minutesAfter(last.started_at, RUN_GAP_MINUTES))}.`;
  return { models, estimateUsd, wait };
}

// Queues one test per model the user can choose now; the user's earlier
// runs at this provider go. Refuses, with the plain reason, while it may not
// start.
export async function startTestAll(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider, now: Date): Promise<{ problem: string } | { runId: number }> {
  const plan = await planTestAll(db, plugins, userId, provider, now);
  if (plan.wait) return { problem: plan.wait };
  await db.batch([
    db.prepare("DELETE FROM model_tests WHERE user_id = ? AND provider = ?").bind(userId, provider),
    db.prepare("DELETE FROM model_test_runs WHERE user_id = ? AND provider = ?").bind(userId, provider),
  ]);
  const run = await db
    .prepare("INSERT INTO model_test_runs (user_id, provider, started_at, model_count, estimate_usd) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .bind(userId, provider, now.toISOString(), plan.models.length, plan.estimateUsd)
    .first<{ id: number }>();
  const runId = run!.id;
  await db
    .prepare(
      `INSERT INTO model_tests (run_id, user_id, provider, model, state)
       SELECT ?1, ?2, ?3, j.value, 'queued' FROM json_each(?4) AS j`,
    )
    .bind(runId, userId, provider, JSON.stringify(plan.models.map((m) => m.model)))
    .run();
  return { runId };
}

// Runs `jobs` with at most `limit` running at once.
async function pooled<T>(items: readonly T[], limit: number, job: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) await job(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

// The cron: the oldest queued tests, PER_TICK at most, CONCURRENCY at once.
// A test that throws is recorded as failed with no reply, so a run always
// finishes. Returns how many ran.
export async function runQueuedTests(db: D1Database, plugins: PluginRegistry, now: Date): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT t.run_id, t.user_id, t.provider, t.model FROM model_tests t
       WHERE t.state = 'queued' ORDER BY t.run_id, t.model LIMIT ?`,
    )
    .bind(PER_TICK)
    .all<{ run_id: number; user_id: string; provider: Provider; model: string }>();
  if (!results.length) return 0;
  const otherIds = (await readCurrentCatalog(db))?.models.map((m) => m.id) ?? [];
  await pooled(results, CONCURRENCY, async (t) => {
    const plugin = plugins[t.provider];
    let row: Omit<ModelTestRow, "model">;
    try {
      if (!plugin) throw new Error("no plug-in");
      const location = plugin.connect.locations(t.model)[0] ?? "global";
      const outcome = await testModel(db, plugin, plugins, { userId: t.user_id, model: t.model, location, otherIds, now, task: TEST_ALL_TASK });
      if (outcome.kind === "added") {
        await saveUserModel(db, t.user_id, outcome.model);
        row = { state: "passed", result: { text: "Works now.", replyText: outcome.model.test?.text }, costUsd: outcome.model.test?.costUsd };
      } else {
        row = { state: "failed", result: { reason: outcome.reason, text: refusalText(outcome, plugin), reply: outcome.reply && { status: outcome.reply.status, errorName: outcome.reply.errorName, message: outcome.reply.message } } };
      }
    } catch (error) {
      console.warn(`test all models: a test failed to run: ${error instanceof Error ? error.name : "error"}`);
      row = { state: "failed", result: { reason: "no_reply", text: "The test could not run." } };
    }
    await db
      .prepare("UPDATE model_tests SET state = ?, result = ?, cost_usd = ?, tested_at = ? WHERE run_id = ? AND model = ?")
      .bind(row.state, JSON.stringify(row.result), row.costUsd ?? null, now.toISOString(), t.run_id, t.model)
      .run();
  });
  await db
    .prepare(
      `UPDATE model_test_runs SET finished_at = ? WHERE finished_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM model_tests t WHERE t.run_id = model_test_runs.id AND t.state = 'queued')`,
    )
    .bind(now.toISOString())
    .run();
  return results.length;
}

export async function readTestAll(db: D1Database, userId: string, provider: Provider): Promise<TestAllRun | undefined> {
  const run = await latestRun(db, userId, provider);
  if (!run) return undefined;
  const { results } = await db
    .prepare("SELECT model, state, result, cost_usd, tested_at FROM model_tests WHERE run_id = ? ORDER BY model")
    .bind(run.id)
    .all<{ model: string; state: ModelTestRow["state"]; result: string | null; cost_usd: number | null; tested_at: string | null }>();
  const spent = await db
    .prepare("SELECT coalesce(sum(cost_usd), 0) AS usd FROM model_calls WHERE user_id = ? AND provider = ? AND task = ? AND at >= ?")
    .bind(userId, provider, TEST_ALL_TASK, run.started_at)
    .first<{ usd: number }>();
  const tests: ModelTestRow[] = results.map((r) => ({
    model: r.model,
    state: r.state,
    result: r.result ? (JSON.parse(r.result) as ModelTestRow["result"]) : undefined,
    costUsd: r.cost_usd ?? undefined,
    testedAt: r.tested_at ?? undefined,
  }));
  return {
    id: run.id,
    startedAt: run.started_at,
    finishedAt: run.finished_at ?? undefined,
    modelCount: run.model_count,
    estimateUsd: run.estimate_usd,
    tests,
    done: tests.filter((t) => t.state !== "queued").length,
    realCostUsd: spent?.usd ?? 0,
  };
}
