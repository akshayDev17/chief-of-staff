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
//   planRetest / startRetest                                         Retest failed: the run's failures again, in the same run
//   shownTests(run, latest) -> Map<model, ShownTest>                  what each model's row shows, and its verdict
//
// Each test is the model's own test call (models/test-model.ts testModel)
// through the proxy, which prices it and writes its ledger row under the task
// `test_all_models`. Its reply is capped at 16 tokens; a 200 with no text (a
// reasoning model that spent them thinking) counts as working. Each result
// is recorded in the run, and each verdict becomes the model's latest test
// (models/usable.ts), so a model that passes is one the user's tasks can use
// and one that fails is not, as with Test on its row. A refusal that says
// nothing about the model (models/test-model.ts isVerdict: not connected,
// the budget spent, no credential, no credit, busy, or a test that could not
// run) shows on the model's row and changes nothing else. The estimate is each model's last measured test cost where the user has one
// (its latest answered test call's ledger row: the same request, so the same
// price), otherwise its list prices for the test's tokens (at most
// ESTIMATE_INPUT_TOKENS in and the 16-token cap out), plus any fee per call
// and, for a model that searches the web on its own, one search. The run of
// 2026-11-27 09:49 UTC cost $0.35 against a $0.07 list-price estimate: per-search
// fees were $0.24 of it (Perplexity's Sonar Deep Research alone $0.23 for 8 tokens
// in and 16 out), and some models billed 1,300-2,100 input tokens for the
// one-line prompt; a second run costs what the first measured. The real total
// is the sum of the run's ledger rows: the cost OpenRouter reported for each call.
//
// Retest failed reruns a finished run's failures, verdicts or not, that can
// still be tested and have not passed since, in the same run (its rows go back to queued and
// the run reopens), so the results keep the models that passed in the full
// run. A run made on an older model list (catalog version) offers no Retest
// failed.
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
import { CATALOG_VERSION, isCurrentCatalog } from "../prices/openrouter";
import { TEST_TASK } from "../proxy/proxy";
import { readCurrentCatalog } from "../prices/store";
import type { Provider } from "../prices/types";
import { readConnection } from "../proxy/connections";
import type { PluginRegistry, ProviderPlugin } from "../proxy/plugin";
import { blockedReason, isVerdict, listOffer, testModel, testRecord, type OfferRow } from "./test-model";
import { latestTestWrite, readLatestTests, type LatestTest, type TestRecord } from "./usable";

export const TEST_ALL_TASK = "test_all_models";
export const RUN_GAP_MINUTES = 10;
export const PER_TICK = 50;
export const CONCURRENCY = 5;
export const CLAIM_MINUTES = 10;
// The test prompt ("Reply with the single word OK.") with a chat template's
// own tokens around it, rounded well up.
export const ESTIMATE_INPUT_TOKENS = 40;

export interface TestAllPlan {
  // `measured`: the estimate is the model's last measured test cost.
  models: Array<{ model: string; location: string; estimateUsd: number; measured?: boolean }>;
  estimateUsd: number;
  // Why a run cannot start now, if it cannot.
  wait?: string;
}

export interface ModelTestRow {
  model: string;
  state: "queued" | "running" | "passed" | "failed";
  // The plain reason, the provider's own words, and the fix with the pages to
  // open, for a failure; the passed test call, for a pass.
  result?: TestRecord;
  costUsd?: number;
  testedAt?: string;
}

export interface TestAllRun {
  id: number;
  startedAt: string;
  finishedAt?: string;
  // The model list's rules it ran on; older than CATALOG_VERSION: stale.
  catalogVersion?: number;
  retestedAt?: string;
  retestCount?: number;
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
  catalog_version: number | null;
  retested_at: string | null;
  retest_count: number | null;
}

async function latestRun(db: D1Database, userId: string, provider: Provider): Promise<RunRecord | undefined> {
  return (
    (await db
      .prepare(
        "SELECT id, started_at, finished_at, model_count, estimate_usd, catalog_version, retested_at, retest_count FROM model_test_runs WHERE user_id = ? AND provider = ? ORDER BY id DESC LIMIT 1",
      )
      .bind(userId, provider)
      .first<RunRecord>()) ?? undefined
  );
}

// While the stored model list predates parseModels' rules: no run starts,
// and a queued one waits.
export const FRESH_LIST_WAIT = "Waiting for a fresh model list: press Refresh model list.";

// A run made on the current model list's rules.
export const isCurrentRun = (run: Pick<TestAllRun, "catalogVersion"> | undefined): boolean => run?.catalogVersion === CATALOG_VERSION;

// Each model's last measured test cost for this user: its latest answered
// (2xx) test call, from Test all models or a single test. A refused call
// costs nothing and would understate the next one, so it is not used.
export async function measuredTestCosts(db: D1Database, userId: string, provider: Provider): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT model, cost_usd, max(id) AS last FROM model_calls
       WHERE user_id = ? AND provider = ? AND task IN (?, ?) AND status >= 200 AND status < 300 GROUP BY model`,
    )
    .bind(userId, provider, TEST_ALL_TASK, TEST_TASK)
    .all<{ model: string; cost_usd: number }>();
  return new Map(results.map((r) => [r.model, r.cost_usd]));
}

// One model's test cost at list price: the test's tokens, any fee per call
// (`request`, kept per million calls) and, for a model that searches the web
// on its own, one search.
export const listPriceTestCost = (price: NonNullable<OfferRow["price"]>, searchFeeUsd = 0): number =>
  (ESTIMATE_INPUT_TOKENS * price.input + TEST_MAX_TOKENS * price.output + (price.request ?? 0)) / 1_000_000 + searchFeeUsd;

// The estimate of each model's test call: measured where known, else list price.
export function estimateTests(rows: OfferRow[], plugin: ProviderPlugin, measured: Map<string, number>): TestAllPlan["models"] {
  return rows.flatMap((r) => {
    if (blockedReason(r, plugin) || !r.price) return [];
    const known = measured.get(r.model);
    return [
      known !== undefined
        ? { model: r.model, location: r.location, estimateUsd: known, measured: true }
        : { model: r.model, location: r.location, estimateUsd: listPriceTestCost(r.price, plugin.connect.searchFee?.(r.model)) },
    ];
  });
}

// `offers`: the model list, when the caller has read it already.
export async function planTestAll(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider, now: Date, offers?: OfferRow[]): Promise<TestAllPlan> {
  const plugin = plugins[provider];
  if (!plugin) return { models: [], estimateUsd: 0, wait: "That provider is not offered." };
  offers ??= await listOffer(db, plugins, userId, provider);
  const models = estimateTests(offers, plugin, await measuredTestCosts(db, userId, provider));
  const estimateUsd = models.reduce((sum, m) => sum + m.estimateUsd, 0);
  const last = await latestRun(db, userId, provider);
  let wait: string | undefined;
  if (!isCurrentCatalog(await readCurrentCatalog(db))) wait = FRESH_LIST_WAIT;
  else if (!(await readConnection(db, userId, provider))) wait = `${plugin.connect.guide.name} is not connected.`;
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
        .prepare("INSERT INTO model_test_runs (user_id, provider, started_at, model_count, estimate_usd, catalog_version) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
        .bind(userId, provider, now.toISOString(), plan.models.length, plan.estimateUsd, CATALOG_VERSION),
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
// throws is recorded in the run as failed with no reply, so a run always
// finishes. Only the tick holding a test's claim records its result. Nothing is claimed
// while the model list predates parseModels' rules, so no test runs on an old
// list's verdicts: the tests wait for the daily refresh or Refresh model
// list (FRESH_LIST_WAIT). Returns how many ran.
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
    let row: { state: "passed" | "failed"; result: TestRecord; costUsd?: number; verdict: boolean };
    try {
      if (!plugin) throw new Error("no plug-in");
      const location = plugin.connect.locations(t.model)[0] ?? "global";
      const outcome = await testModel(db, plugin, plugins, { userId: t.user_id, model: t.model, location, otherIds, now, task: TEST_ALL_TASK, free: free.has(t.model) });
      row = {
        state: outcome.kind === "passed" ? "passed" : "failed",
        result: testRecord(outcome, plugin),
        ...(outcome.kind === "passed" ? { costUsd: outcome.test.costUsd } : {}),
        verdict: isVerdict(outcome),
      };
    } catch (error) {
      console.warn(`test all models: a test failed to run: ${error instanceof Error ? error.name : "error"}`);
      row = { state: "failed", result: { reason: "no_reply", text: "The test could not run." }, verdict: false };
    }
    const recorded = await db
      .prepare("UPDATE model_tests SET state = ?, result = ?, cost_usd = ?, tested_at = ? WHERE run_id = ? AND model = ? AND state = 'running' AND claimed_at = ?")
      .bind(row.state, JSON.stringify(row.result), row.costUsd ?? null, now.toISOString(), t.run_id, t.model, claimedAt)
      .run();
    // Only the tick holding the claim makes a verdict the model's latest test.
    if (recorded.meta.changes && row.verdict) await latestTestWrite(db, t.user_id, t.provider, t.model, row.state, row.result, now).run();
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
    ...(run.catalog_version !== null ? { catalogVersion: run.catalog_version } : {}),
    ...(run.retested_at ? { retestedAt: run.retested_at, retestCount: run.retest_count ?? 0 } : {}),
    modelCount: run.model_count,
    estimateUsd: run.estimate_usd,
    tests,
    done: tests.filter((t) => t.state === "passed" || t.state === "failed").length,
    realCostUsd: spent?.usd ?? 0,
  };
}

// Retest failed: the latest run's failures, verdicts or not, that can still
// be tested and have not passed since, their estimate, and how many failures are no longer on
// the model list. `wait` says why it cannot start now, if it cannot.
export interface RetestPlan {
  models: TestAllPlan["models"];
  estimateUsd: number;
  skipped: number;
  wait?: string;
}

export async function planRetest(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider, offers?: OfferRow[]): Promise<RetestPlan> {
  const plugin = plugins[provider];
  if (!plugin) return { models: [], estimateUsd: 0, skipped: 0, wait: "That provider is not offered." };
  const run = await readTestAll(db, userId, provider);
  const latest = await readLatestTests(db, userId, provider);
  const failed = new Set((run?.tests ?? []).filter((t) => t.state === "failed" && !passedSince(latest.get(t.model), t.testedAt)).map((t) => t.model));
  offers ??= await listOffer(db, plugins, userId, provider);
  const models = estimateTests(offers.filter((r) => failed.has(r.model)), plugin, await measuredTestCosts(db, userId, provider));
  const plan = { models, estimateUsd: models.reduce((sum, m) => sum + m.estimateUsd, 0), skipped: failed.size - models.length };
  let wait: string | undefined;
  if (!run) wait = "Run Test all first.";
  else if (!run.finishedAt) wait = "Waits for the run to finish.";
  else if (!isCurrentRun(run) || !isCurrentCatalog(await readCurrentCatalog(db))) wait = "The last run used the old model list.";
  else if (!failed.size) wait = "Nothing failed in the last run.";
  else if (!models.length) wait = "None of the failures is on the model list now.";
  return wait ? { ...plan, wait } : plan;
}

// Queues the latest run's failures that can still be chosen again, in the
// same run: their rows go back to queued and the run reopens for the cron.
export async function startRetest(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider, now: Date): Promise<{ problem: string } | { count: number; skipped: number }> {
  const plan = await planRetest(db, plugins, userId, provider);
  if (plan.wait) return { problem: plan.wait };
  const run = (await latestRun(db, userId, provider))!;
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE model_tests SET state = 'queued', result = NULL, cost_usd = NULL, tested_at = NULL, claimed_at = NULL
           WHERE run_id = ?1 AND user_id = ?2 AND state = 'failed' AND model IN (SELECT value FROM json_each(?3))`,
        )
        .bind(run.id, userId, JSON.stringify(plan.models.map((m) => m.model))),
      db
        .prepare("UPDATE model_test_runs SET finished_at = NULL, retested_at = ?, retest_count = ?, estimate_usd = estimate_usd + ? WHERE id = ? AND user_id = ? AND finished_at IS NOT NULL")
        .bind(now.toISOString(), plan.models.length, plan.estimateUsd, run.id, userId),
    ]);
  } catch (error) {
    const again = await planRetest(db, plugins, userId, provider);
    if (again.wait) return { problem: again.wait };
    throw error;
  }
  return { count: plan.models.length, skipped: plan.skipped };
}

const isNewer = (a: string, b: string): boolean => Date.parse(a) > Date.parse(b);

// The model's latest test passed after `at`.
const passedSince = (latest: LatestTest | undefined, at: string | undefined): boolean =>
  latest?.state === "passed" && (at === undefined || isNewer(latest.testedAt, at));

// What a model's row shows: `state`, `testedAt` and `result` are the test it
// reports, `testing` while the latest run still has it queued or running;
// `verdict` is its latest test (models/usable.ts), which says whether tasks
// can use it and which the strip counts, absent while it has none. The
// reported test is the latest one, or the run's newer refusal that says
// nothing about the model and so made no latest test. While the run tests a
// model, its latest test, and so whether tasks can use it, stays as it was.
export type ShownTest = { state: "testing" } | ({ state: LatestTest["state"]; verdict?: LatestTest["state"] } & Pick<LatestTest, "testedAt" | "result">);

export function shownTests(run: TestAllRun | undefined, latest: Map<string, LatestTest>): Map<string, ShownTest> {
  const out = new Map<string, ShownTest>();
  for (const [model, t] of latest) out.set(model, { state: t.state, verdict: t.state, testedAt: t.testedAt, result: t.result });
  for (const t of run?.tests ?? []) {
    const l = latest.get(t.model);
    if ((t.state === "queued" || t.state === "running") && !run!.finishedAt) out.set(t.model, { state: "testing" });
    else if (t.state === "failed" && t.result && t.testedAt && (!l || isNewer(t.testedAt, l.testedAt))) {
      out.set(t.model, { state: "failed", ...(l ? { verdict: l.state } : {}), testedAt: t.testedAt, result: t.result });
    }
  }
  return out;
}
