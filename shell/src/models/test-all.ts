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
//   addTestedModel(db, plugins, userId, provider, model, now)        Add, on a model that passed in the latest run
//
// Each test is the model's own test call (models/add.ts testModel) through
// the proxy, which prices it and writes its ledger row under the task
// `test_all_models`. Its reply is capped at 16 tokens; a 200 with no text (a
// reasoning model that spent them thinking) counts as working. A run only
// records what works and what does not, with the plain reason: it adds
// nothing to the user's models. The results list offers Add on each model
// that passed, which adds it with that passed test call, making no new one.
// The estimate is the models' list prices for the test's tokens: at most
// ESTIMATE_INPUT_TOKENS in and the 16-token cap out, plus any fee per call.
// The real total is the sum of the run's ledger rows: the cost OpenRouter
// reported for each call.
//
// Limits: one run at a time per user and provider (a unique index holds it
// even when two starts race), a new one at most every RUN_GAP_MINUTES, and
// the cron runs at most PER_TICK tests a minute across every user,
// CONCURRENCY at once, so a run of ~460 models takes about ten minutes and
// stays inside the Worker's per-invocation limits. A tick claims its tests
// before calling, so a tick that overlaps the one before never tests the
// same model twice; a claim older than CLAIM_MINUTES (a tick that died) may
// be taken again, so a run always finishes.

import { TEST_MAX_TOKENS } from "../providers/openrouter";
import { isCurrentCatalog } from "../prices/refresh";
import { readCurrentCatalog } from "../prices/store";
import type { Provider } from "../prices/types";
import { readConnection } from "../proxy/connections";
import type { Link, PluginRegistry } from "../proxy/plugin";
import { blockedReason, listOffer, refusalFix, refusalText, saveUserModel, testModel, type AddOutcome, type AddRefusal, type OfferRow, type TestResult, type UserModel } from "./add";

export const TEST_ALL_TASK = "test_all_models";
export const RUN_GAP_MINUTES = 10;
export const PER_TICK = 50;
export const CONCURRENCY = 5;
export const CLAIM_MINUTES = 10;
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
  state: "queued" | "running" | "passed" | "failed";
  // The plain reason, the provider's own words, and the fix with the pages to
  // open, for a failure; the passed test call, for a pass.
  result?: { reason?: AddRefusal; text: string; reply?: { status: number; errorName?: string; message?: string }; fix?: string; links?: Link[]; test?: TestResult };
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
      ? [{ model: r.model, location: r.location, estimateUsd: (ESTIMATE_INPUT_TOKENS * r.price.input + TEST_MAX_TOKENS * r.price.output + (r.price.request ?? 0)) / 1_000_000 }]
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
// start. The run and its tests are written in one transaction, which the
// unique index on open runs fails when another start got there first.
export async function startTestAll(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider, now: Date): Promise<{ problem: string } | { runId: number }> {
  const plan = await planTestAll(db, plugins, userId, provider, now);
  if (plan.wait) return { problem: plan.wait };
  let written: D1Result[];
  try {
    written = await db.batch([
      db.prepare("DELETE FROM model_tests WHERE run_id IN (SELECT id FROM model_test_runs WHERE user_id = ? AND provider = ? AND finished_at IS NOT NULL)").bind(userId, provider),
      db.prepare("DELETE FROM model_test_runs WHERE user_id = ? AND provider = ? AND finished_at IS NOT NULL").bind(userId, provider),
      db
        .prepare("INSERT INTO model_test_runs (user_id, provider, started_at, model_count, estimate_usd) VALUES (?, ?, ?, ?, ?) RETURNING id")
        .bind(userId, provider, now.toISOString(), plan.models.length, plan.estimateUsd),
      db
        .prepare(
          `INSERT INTO model_tests (run_id, user_id, provider, model, state)
           SELECT (SELECT id FROM model_test_runs WHERE user_id = ?1 AND provider = ?2 AND finished_at IS NULL), ?1, ?2, j.value, 'queued' FROM json_each(?3) AS j`,
        )
        .bind(userId, provider, JSON.stringify(plan.models.map((m) => m.model))),
    ]);
  } catch (error) {
    const again = await planTestAll(db, plugins, userId, provider, now);
    if (again.wait) return { problem: again.wait };
    throw error;
  }
  return { runId: (written[2]!.results[0] as { id: number }).id };
}

// Runs `jobs` with at most `limit` running at once.
async function pooled<T>(items: readonly T[], limit: number, job: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) await job(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

// The cron: the oldest queued tests (and stale claims), PER_TICK at most,
// claimed in one statement, then called CONCURRENCY at once. A test that
// throws is recorded as failed with no reply, so a run always finishes. Only
// the tick holding a test's claim records its result. Nothing is claimed
// while the model list predates parseModels' rules, so no test runs on an old
// list's verdicts; the cron reads it again first (index.ts). Returns how many ran.
export async function runQueuedTests(db: D1Database, plugins: PluginRegistry, now: Date): Promise<number> {
  const stored = await readCurrentCatalog(db);
  if (!isCurrentCatalog(stored)) return 0;
  const claimedAt = now.toISOString();
  const staleBefore = new Date(now.getTime() - CLAIM_MINUTES * 60_000).toISOString();
  const { results } = await db
    .prepare(
      `UPDATE model_tests SET state = 'running', claimed_at = ?1
       WHERE rowid IN (SELECT rowid FROM model_tests WHERE state = 'queued' OR (state = 'running' AND claimed_at < ?2)
                       ORDER BY run_id, model LIMIT ?3)
       RETURNING run_id, user_id, provider, model`,
    )
    .bind(claimedAt, staleBefore, PER_TICK)
    .all<{ run_id: number; user_id: string; provider: Provider; model: string }>();
  if (!results.length) return 0;
  const catalog = stored!.models;
  const otherIds = catalog.map((m) => m.id);
  const free = new Set(catalog.filter((m) => m.free).map((m) => m.id));
  await pooled(results, CONCURRENCY, async (t) => {
    const plugin = plugins[t.provider];
    let row: Omit<ModelTestRow, "model">;
    try {
      if (!plugin) throw new Error("no plug-in");
      const location = plugin.connect.locations(t.model)[0] ?? "global";
      const outcome = await testModel(db, plugin, plugins, { userId: t.user_id, model: t.model, location, otherIds, now, task: TEST_ALL_TASK, free: free.has(t.model) });
      if (outcome.kind === "added") {
        row = { state: "passed", result: { text: "Works now.", test: outcome.model.test }, costUsd: outcome.model.test?.costUsd };
      } else {
        const fix = refusalFix(outcome, plugin);
        row = {
          state: "failed",
          result: {
            reason: outcome.reason,
            text: refusalText(outcome, plugin),
            reply: outcome.reply && { status: outcome.reply.status, errorName: outcome.reply.errorName, message: outcome.reply.message },
            ...(fix ? { fix } : {}),
            ...(outcome.links?.length ? { links: outcome.links } : {}),
          },
        };
      }
    } catch (error) {
      console.warn(`test all models: a test failed to run: ${error instanceof Error ? error.name : "error"}`);
      row = { state: "failed", result: { reason: "no_reply", text: "The test could not run." } };
    }
    await db
      .prepare("UPDATE model_tests SET state = ?, result = ?, cost_usd = ?, tested_at = ? WHERE run_id = ? AND model = ? AND state = 'running' AND claimed_at = ?")
      .bind(row.state, JSON.stringify(row.result), row.costUsd ?? null, now.toISOString(), t.run_id, t.model, claimedAt)
      .run();
  });
  await db
    .prepare(
      `UPDATE model_test_runs SET finished_at = ? WHERE finished_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM model_tests t WHERE t.run_id = model_test_runs.id AND t.state IN ('queued', 'running'))`,
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
    done: tests.filter((t) => t.state === "passed" || t.state === "failed").length,
    realCostUsd: spent?.usd ?? 0,
  };
}

// Add, on the results list: a model that passed in the user's latest run at
// the provider becomes one of their models, with that run's passed test call
// as its test; no new call is made. Refused for any other model.
export async function addTestedModel(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider, model: string, now: Date): Promise<AddOutcome> {
  if (!plugins[provider] || !(await readConnection(db, userId, provider))) return { kind: "refused", model, reason: "not_connected" };
  const run = await latestRun(db, userId, provider);
  const passed = run
    ? await db
        .prepare("SELECT result FROM model_tests WHERE run_id = ? AND user_id = ? AND provider = ? AND model = ? AND state = 'passed'")
        .bind(run.id, userId, provider, model)
        .first<{ result: string | null }>()
    : null;
  const test = passed?.result ? (JSON.parse(passed.result) as ModelTestRow["result"])?.test : undefined;
  if (!test) return { kind: "refused", model, reason: "not_passed" };
  const added: UserModel = { provider, model, location: test.location, addedAt: now.toISOString(), test };
  await saveUserModel(db, userId, added);
  return { kind: "added", model: added };
}
