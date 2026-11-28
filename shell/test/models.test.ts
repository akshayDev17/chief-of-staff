import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { FREE_NOTE, listOffer, namesPickedModel, testOne, blockKind } from "../src/models/test-model";
import { readLatestTests, readUsableModels } from "../src/models/usable";
import { parsePriceCap, savePriceCap } from "../src/models/price-caps";
import { renderPickerPage, handleTaskModels, type PickerPageInput } from "../src/models/picker-page";
import { readModelNames, readToTest } from "../src/models/picker-data";
import { acceptProposals, callTask, changeTasks, offeredFor, proposeRoute, readTaskRoutes, routeTask, taskById, TASKS, type Offered } from "../src/models/tasks";
import { TASK_MODELS_PATH } from "../src/paths";
import { ESTIMATE_INPUT_TOKENS, planRetest, planTestAll, PER_TICK, readTestAll, runQueuedTests, shownTests, startRetest, startTestAll } from "../src/models/test-all";
import { classify, TEST_MAX_TOKENS } from "../src/providers/openrouter";
import { formatCost, modelParts, type ModelsTableInput } from "../src/providers/models-table";
import { setBudget } from "../src/proxy/budgets";
import { writeConnection } from "../src/proxy/connections";
import { writeSnapshot } from "../src/prices/store";
import { ok, recordTest, refused, row, seedPrices, TEST_CATALOG, testPlugin, userFor, type TestPlugin } from "./test-plugin";

const NOW = new Date("2026-11-27T10:00:00Z");
const ORIGIN = "https://cos.example.com";
let plugin: TestPlugin;
let userId: string;
const plugins = () => ({ openrouter: plugin });

beforeEach(async () => {
  await seedPrices();
  plugin = testPlugin("openrouter", { routers: ["openrouter/auto"] });
  userId = (await userFor("owner-sub")).id;
  await writeConnection(env.DB, userId, plugin, { method: "oauth_pkce", key_hash: "a".repeat(64) }, NOW);
});

const usable = async () => (await readUsableModels(env.DB, userId)).map((m) => m.model);
const userModelRows = async () => (await env.DB.prepare("SELECT count(*) AS n FROM user_models").first<{ n: number }>())!.n;

describe("the model list", () => {
  it("lists every model OpenRouter lists, priced and tiered, and the router without a price until it has a cap", async () => {
    const rows = await listOffer(env.DB, plugins(), userId, "openrouter");
    expect(rows.map((r) => r.model)).toEqual(["openrouter/auto", "test-luna", "test-mini", "test-sonnet"]);
    expect(rows.find((r) => r.model === "test-luna")).toMatchObject({ price: { input: 0.1, output: 0.5, source: "openrouter-models" }, tier: "Smallest", callable: true, accountLeftOut: false });
    expect(rows.find((r) => r.model === "test-sonnet")?.tier).toBe("Strongest");
    const auto = rows.find((r) => r.model === "openrouter/auto")!;
    expect(auto).toMatchObject({ router: true });
    expect(auto.price).toBeUndefined();
    expect(blockKind(auto)).toBe("router");
  });

  it("marks a model the user's own account leaves out, and tests it with no call", async () => {
    await env.DB.prepare("INSERT INTO provider_model_lists (user_id, provider, read_at, models) VALUES (?, 'openrouter', ?, ?)")
      .bind(userId, NOW.toISOString(), JSON.stringify(["test-luna", "test-sonnet"]))
      .run();
    const rows = await listOffer(env.DB, plugins(), userId, "openrouter");
    expect(rows.find((r) => r.model === "test-mini")?.accountLeftOut).toBe(true);
    expect(await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-mini", now: NOW })).toMatchObject({ kind: "refused", reason: "cannot_call" });
    expect(plugin.calls).toEqual([]);
    expect((await readLatestTests(env.DB, userId, "openrouter")).size).toBe(0);
  });

  it("makes a model usable when its test passes, adds nothing, and a later failed test takes it out", async () => {
    plugin.replies.push(ok({ input: 9, output: 1, reportedCostUsd: 0.000002 }, { model: "test-luna" }));
    expect(await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-luna", now: NOW })).toMatchObject({ kind: "passed", test: { status: 200, costUsd: 0.000002 } });
    expect(await usable()).toEqual(["test-luna"]);
    expect(await userModelRows()).toBe(0);
    plugin.replies.push(refused(400));
    const later = new Date("2026-11-27T10:05:00Z");
    expect(await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-luna", now: later })).toMatchObject({ kind: "refused", reason: "refused" });
    expect(await usable()).toEqual([]);
    expect((await readLatestTests(env.DB, userId, "openrouter")).get("test-luna")).toMatchObject({ state: "failed", testedAt: later.toISOString(), result: { reason: "refused", reply: { status: 400 } } });
    plugin.replies.push(ok({ input: 9, output: 1 }, { model: "test-luna" }));
    await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-luna", now: new Date("2026-11-27T10:06:00Z") });
    expect(await usable()).toEqual(["test-luna"]);
  });

  it("keeps a usable model usable after a single Test's refusal that says nothing about the model", async () => {
    plugin.replies.push(ok({ input: 9, output: 1, reportedCostUsd: 0.02 }, { model: "test-luna" }));
    await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-luna", now: NOW });
    const passed = (await readLatestTests(env.DB, userId, "openrouter")).get("test-luna");
    const at = (minute: number) => new Date(`2026-11-27T10:${String(minute).padStart(2, "0")}:00Z`);
    const expectUnchanged = async () => {
      expect(await usable()).toEqual(["test-luna"]);
      expect((await readLatestTests(env.DB, userId, "openrouter")).get("test-luna")).toEqual(passed);
    };
    for (const [status, reason] of [[429, "busy"], [402, "no_credits"], [401, "not_set_up"]] as const) {
      plugin.replies.push(refused(status));
      expect(await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-luna", now: at(status % 50) })).toMatchObject({ kind: "refused", reason, notVerdict: true, reply: { status } });
      await expectUnchanged();
    }
    // No credential: the key cannot be minted.
    const noKey = testPlugin("openrouter", { refuseMint: true });
    expect(await testOne(env.DB, { openrouter: noKey }, { userId, provider: "openrouter", model: "test-luna", now: at(20) })).toMatchObject({ kind: "refused", notVerdict: true });
    await expectUnchanged();
    // The month's budget is spent by the first test's $0.02.
    await setBudget(env.DB, userId, "openrouter", 0.01, "typed", NOW);
    expect(await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-luna", now: at(21) })).toMatchObject({ kind: "refused", reason: "budget_spent", notVerdict: true });
    await expectUnchanged();
  });

  it("keeps an older test from replacing a newer one", async () => {
    await recordTest(userId, "test-luna", "failed", "2026-11-27T10:00:00.000Z");
    await recordTest(userId, "test-luna", "passed", "2026-11-27T09:00:00.000Z");
    expect((await readLatestTests(env.DB, userId, "openrouter")).get("test-luna")?.state).toBe("failed");
  });

  it("uses a passed model only while the provider's list still offers it to the user", async () => {
    await recordTest(userId, "test-luna");
    await recordTest(userId, "test-mini");
    expect(await usable()).toEqual(["test-luna", "test-mini"]);
    // The account's own list leaves one out.
    await env.DB.prepare("INSERT INTO provider_model_lists (user_id, provider, read_at, models) VALUES (?, 'openrouter', ?, ?)").bind(userId, NOW.toISOString(), JSON.stringify(["test-luna"])).run();
    expect(await usable()).toEqual(["test-luna"]);
    // The provider stops listing it.
    await writeSnapshot(env.DB, {
      takenAt: "2026-11-27T11:00:00Z", status: "good", results: [],
      catalog: { ...TEST_CATALOG, models: TEST_CATALOG.models.filter((m) => m.id !== "test-luna") },
      rows: [row("test-mini", "input", 0.25), row("test-mini", "output", 1)],
    });
    expect(await usable()).toEqual([]);
  });

  it("fails a reply that names another model, but takes a variant or a dated ID as the same", async () => {
    plugin.replies.push(ok({ input: 1, output: 1 }, { model: "test-sonnet" }));
    expect(await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-luna", now: NOW })).toMatchObject({ kind: "refused", reason: "wrong_model" });
    expect(await usable()).toEqual([]);
    expect(namesPickedModel("openai/gpt-oss-20b", "openai/gpt-oss-20b:batch")).toBe(true);
    expect(namesPickedModel("anthropic/claude-haiku-5.5-20261001", "anthropic/claude-haiku-5.5")).toBe(true);
    expect(namesPickedModel("openai/gpt-6-luna-pro", "openai/gpt-6-luna")).toBe(false);
  });
});

describe("a router's price cap", () => {
  it("refuses a router with no cap before any call, and calls it under the cap once set", async () => {
    expect(await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "openrouter/auto", now: NOW })).toMatchObject({ kind: "refused", reason: "no_cap" });
    expect(plugin.calls).toEqual([]);
    await savePriceCap(env.DB, userId, "openrouter", "openrouter/auto", { input: 3, output: 15 }, NOW);
    const auto = (await listOffer(env.DB, plugins(), userId, "openrouter")).find((r) => r.model === "openrouter/auto")!;
    expect(auto).toMatchObject({ cap: { input: 3, output: 15 }, price: { input: 3, output: 15 }, tier: "Strongest" });
    expect(blockKind(auto)).toBeUndefined();
    plugin.replies.push(ok({ input: 9, output: 2 }, { model: "openrouter/auto" }));
    expect(await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "openrouter/auto", now: NOW })).toMatchObject({ kind: "passed" });
    expect(plugin.calls[0]).toMatchObject({ model: "openrouter/auto", maxPrice: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } });
    // With no reported cost, the ledger prices the call at the cap.
    const { cost_usd } = (await env.DB.prepare("SELECT cost_usd FROM model_calls WHERE model = 'openrouter/auto'").first<{ cost_usd: number }>())!;
    expect(cost_usd).toBeCloseTo((9 * 3 + 2 * 15) / 1e6, 12);
    expect(await usable()).toEqual(["openrouter/auto"]);
  });

  it("shows OpenRouter's own words when it refuses a call under the cap", async () => {
    await savePriceCap(env.DB, userId, "openrouter", "openrouter/auto", { input: 0.01, output: 0.01 }, NOW);
    plugin.replies.push({ status: 404, body: { error: { code: 404, message: "No endpoints found matching your data policy and max_price" } }, error: { name: "HTTP 404", message: "No endpoints found matching your data policy and max_price" } });
    const outcome = await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "openrouter/auto", now: NOW });
    expect(outcome).toMatchObject({ kind: "refused", reason: "cap_refused", reply: { status: 404, message: "No endpoints found matching your data policy and max_price" } });
    expect((await readLatestTests(env.DB, userId, "openrouter")).get("openrouter/auto")?.result).toMatchObject({ reason: "cap_refused", text: "openrouter refused the call under your price cap.", fix: expect.stringMatching(/Raise the price cap/) });
  });

  it("takes two prices above $0 and at most $1000, as typed", () => {
    expect(parsePriceCap("3", "$15.00")).toEqual({ input: 3, output: 15 });
    expect(parsePriceCap("1,000", "0.5")).toEqual({ input: 1000, output: 0.5 });
    for (const [i, o] of [["0", "1"], ["", "1"], ["1", "-2"], ["1001", "1"], ["abc", "1"]]) expect(parsePriceCap(i!, o!)).toBeUndefined();
  });
});

const tableInput = async (extra: Partial<ModelsTableInput> = {}): Promise<ModelsTableInput> => {
  const rows = await listOffer(env.DB, plugins(), userId, "openrouter");
  const run = await readTestAll(env.DB, userId, "openrouter");
  return {
    plugin, viewer: "owner", rows, plan: await planTestAll(env.DB, plugins(), userId, "openrouter", NOW, rows),
    retest: await planRetest(env.DB, plugins(), userId, "openrouter", rows), run,
    shown: shownTests(run, await readLatestTests(env.DB, userId, "openrouter")), usedBy: new Map(), view: {}, now: NOW,
    catalog: { readAt: TEST_CATALOG.readAt, current: true }, ...extra,
  };
};

describe("Test all models", () => {
  it("shows the estimate first, from the test's tokens at each model's price", async () => {
    const plan = await planTestAll(env.DB, plugins(), userId, "openrouter", NOW);
    expect(plan.models.map((m) => m.model)).toEqual(["test-luna", "test-mini", "test-sonnet"]);
    const expected = [[0.1, 0.5], [0.25, 1], [3, 15]].reduce((s, [i, o]) => s + (ESTIMATE_INPUT_TOKENS * i! + TEST_MAX_TOKENS * o!) / 1e6, 0);
    expect(plan.estimateUsd).toBeCloseTo(expected, 12);
    expect(plan.wait).toBeUndefined();
    const { rail } = modelParts(await tableInput({ view: { confirm: "test-all" }, step: "confirm" }));
    expect(rail).toContain(`Test all 3 models for about ${formatCost(expected)}?`);
    expect(rail).toMatch(/class="btn primary small" data-k="ta-run" data-autofocus>Run the test</);
    expect(rail).toContain("Billed to your Test openrouter account.");
  });

  it("keeps a usable model usable when Test all is refused for reasons that say nothing about the model, and shows the outcome on its row", async () => {
    for (const model of ["test-luna", "test-mini", "test-sonnet"]) await recordTest(userId, model);
    const before = await readLatestTests(env.DB, userId, "openrouter");
    // A test that throws before its call: "The test could not run."
    const testRequest = (model: string) => {
      if (model === "test-sonnet") throw new TypeError("boom");
      return plugin.connect.testRequest(model);
    };
    const throwing = { ...plugin, connect: { ...plugin.connect, testRequest } };
    await startTestAll(env.DB, plugins(), userId, "openrouter", NOW);
    plugin.replies.push(refused(429), refused(402));
    await runQueuedTests(env.DB, { openrouter: throwing }, NOW);
    const run = (await readTestAll(env.DB, userId, "openrouter"))!;
    expect(run.tests.map((t) => [t.model, t.state, t.result?.reason])).toEqual([["test-luna", "failed", "busy"], ["test-mini", "failed", "no_credits"], ["test-sonnet", "failed", "no_reply"]]);
    expect(await usable()).toEqual(["test-luna", "test-mini", "test-sonnet"]);
    expect(await readLatestTests(env.DB, userId, "openrouter")).toEqual(before);
    const shown = shownTests(run, before);
    expect(shown.get("test-luna")).toMatchObject({ state: "failed", verdict: "passed", result: { reason: "busy" } });
    const { rows, strip } = modelParts(await tableInput());
    expect(rows).toMatch(/data-id="test-luna"[^>]*data-state="works"[\s\S]*?<span class="pill">Busy<\/span>/);
    expect(rows).toMatch(/data-id="test-mini"[^>]*data-state="works"[\s\S]*?<span class="pill warn">Needs credit<\/span>/);
    expect(rows).toMatch(/data-id="test-sonnet"[^>]*data-state="works"[\s\S]*?<span class="pill">Couldn't test<\/span>[\s\S]*?The test could not run\. · <button type="button" class="link" data-det=/);
    // None of them is a verdict, so none reads Doesn't work.
    expect(rows).not.toContain("Doesn't work");
    expect(strip).toMatch(/data-filter="works"[\s\S]*?<span class="v num good">3<\/span>/);
    // Retest failed covers every row the run failed, verdict or not.
    expect((await planRetest(env.DB, plugins(), userId, "openrouter")).models.map((m) => m.model)).toEqual(["test-luna", "test-mini", "test-sonnet"]);
  });

  it("keeps a failed verdict on its row, with a newer refusal as a short note, and tags only usable models", async () => {
    await recordTest(userId, "test-luna", "failed");
    await recordTest(userId, "test-mini");
    await startTestAll(env.DB, plugins(), userId, "openrouter", NOW);
    // test-sonnet has no verdict yet.
    plugin.replies.push(refused(429), refused(429), refused(429));
    await runQueuedTests(env.DB, plugins(), NOW);
    expect(await usable()).toEqual(["test-mini"]);
    const rowOf = (html: string, model: string) => html.match(new RegExp(`<li class="row"[^>]*data-id="${model}"[\\s\\S]*?</li>`))![0];
    const { rows, strip } = modelParts(await tableInput());
    const luna = rowOf(rows, "test-luna");
    expect(luna).toContain('data-state="fails"');
    expect(luna).toContain(`<span class="pill bad">Doesn't work</span>`);
    expect(luna).toMatch(/<span class="meta why">No such model\. · <button[^>]*>Details<\/button> · <span class="later">Latest test couldn&#39;t run\. [^<]+<\/span><\/span>/);
    expect(luna).toContain("openrouter replied: 404");
    expect(luna).not.toContain('<span class="pill">Busy</span>');
    // Still usable: the outcome tag.
    expect(rowOf(rows, "test-mini")).toMatch(/data-state="works"[\s\S]*<span class="pill">Busy<\/span>/);
    // No verdict: no tag, the reason line only.
    const sonnet = rowOf(rows, "test-sonnet");
    expect(sonnet).toContain('data-state="pending"');
    expect(sonnet).not.toContain('class="pill');
    expect(strip).toMatch(/data-filter="fails"[\s\S]*?<span class="v num bad">1<\/span>/);
    // The result under the row: the verdict first, then the newer outcome.
    const under = rowOf(modelParts(await tableInput({ view: { results: [{ model: "test-luna" }] } })).rows, "test-luna");
    expect(under).toMatch(/<strong>No such model\.<\/strong>[\s\S]*?<div class="later"><p>Latest test couldn&#39;t run\. /);
    const carried = rowOf(modelParts(await tableInput({ view: { results: [{ model: "test-luna", reason: "budget_spent" }] } })).rows, "test-luna");
    expect(carried).toMatch(/<strong>No such model\.<\/strong><\/span>[\s\S]*?<div class="later"><p>This test couldn&#39;t run\. This month&#39;s budget is spent\.<\/p><div class="acts"><a class="btn small outline" href="[^"]*\/budgets">Budgets<\/a><\/div><\/div>/);
  });

  it("keeps a usable model usable when the user disconnects or the budget runs out while Test all is queued", async () => {
    plugin.replies.push(ok({ input: 9, output: 1, reportedCostUsd: 0.02 }, { model: "test-luna" }));
    await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-luna", now: NOW });
    await recordTest(userId, "test-mini", "passed", NOW.toISOString());
    await setBudget(env.DB, userId, "openrouter", 0.01, "typed", NOW);
    const later = new Date("2026-11-27T10:20:00Z");
    await startTestAll(env.DB, plugins(), userId, "openrouter", later);
    await runQueuedTests(env.DB, plugins(), later);
    expect((await readTestAll(env.DB, userId, "openrouter"))!.tests.every((t) => t.state === "failed" && t.result?.reason === "budget_spent")).toBe(true);
    expect(await usable()).toEqual(["test-luna", "test-mini"]);
    const next = new Date("2026-11-27T10:40:00Z");
    await setBudget(env.DB, userId, "openrouter", 5, "typed", next);
    await startTestAll(env.DB, plugins(), userId, "openrouter", next);
    await env.DB.prepare("DELETE FROM provider_connections").run();
    await runQueuedTests(env.DB, plugins(), next);
    expect((await readTestAll(env.DB, userId, "openrouter"))!.tests.every((t) => t.state === "failed" && t.result?.reason === "not_connected")).toBe(true);
    expect(await usable()).toEqual(["test-luna", "test-mini"]);
    const { rows } = modelParts(await tableInput());
    expect(rows).toMatch(/data-id="test-luna"[^>]*data-state="works"[\s\S]*?<span class="pill">Couldn't test<\/span>/);
    expect(rows).not.toContain("Doesn't work");
  });

  it("runs in the background a few at a time; each result becomes the model's latest test, so the ones that pass are usable", async () => {
    await startTestAll(env.DB, plugins(), userId, "openrouter", NOW);
    plugin.replies.push(
      ok({ input: 9, output: 16, reportedCostUsd: 0.000001 }, { model: "test-luna" }),
      refused(402),
      // A reasoning model that used its few tokens thinking: a 200 with no text works.
      { ...ok({ input: 9, output: 16, reportedCostUsd: 0.00025 }, { model: "test-sonnet" }) },
    );
    expect(await runQueuedTests(env.DB, plugins(), NOW)).toBe(3);
    const run = (await readTestAll(env.DB, userId, "openrouter"))!;
    expect(run.finishedAt).toBe(NOW.toISOString());
    expect(run.tests.map((t) => [t.model, t.state])).toEqual([["test-luna", "passed"], ["test-mini", "failed"], ["test-sonnet", "passed"]]);
    expect(run.tests[1]!.result).toMatchObject({ reason: "no_credits", text: "Needs credit on Test openrouter.", reply: { status: 402 } });
    expect(run.realCostUsd).toBeCloseTo(0.000251, 12);
    expect(await usable()).toEqual(["test-luna", "test-sonnet"]);
    expect(await userModelRows()).toBe(0);
    const { n } = (await env.DB.prepare("SELECT count(*) AS n FROM model_calls WHERE task = 'test_all_models'").first<{ n: number }>())!;
    expect(n).toBe(3);
  });

  it("keeps a model usable while a new run is still testing it", async () => {
    await recordTest(userId, "test-luna");
    await startTestAll(env.DB, plugins(), userId, "openrouter", NOW);
    const run = await readTestAll(env.DB, userId, "openrouter");
    expect(shownTests(run, await readLatestTests(env.DB, userId, "openrouter")).get("test-luna")).toEqual({ state: "testing" });
    expect(await usable()).toEqual(["test-luna"]);
  });

  it("shows a key-limit refusal's fix and the key's own page on OpenRouter under its row", async () => {
    plugin.connect.classify = classify;
    await startTestAll(env.DB, plugins(), userId, "openrouter", NOW);
    const limit = { status: 403, body: { error: { code: 403, message: "Key limit exceeded" } }, error: { name: "HTTP 403", message: "Key limit exceeded" } };
    plugin.replies.push(limit, limit, limit);
    await runQueuedTests(env.DB, plugins(), NOW);
    const run = (await readTestAll(env.DB, userId, "openrouter"))!;
    expect(run.tests[0]!.result).toMatchObject({ reason: "no_credits", fix: expect.stringContaining("reset period"), links: [{ href: "https://openrouter.ai/settings/keys" }, { href: `https://openrouter.ai/keys/${"a".repeat(64)}` }] });
    const { rows } = modelParts(await tableInput({ view: { results: [{ model: "test-luna" }] } }));
    expect(rows).toContain("give it a reset period");
    expect(rows).toContain(`href="https://openrouter.ai/keys/${"a".repeat(64)}"`);
  });

  it("retests the failures in the same run, keeps the passes, and skips one that passed since", async () => {
    await startTestAll(env.DB, plugins(), userId, "openrouter", NOW);
    plugin.replies.push(ok({ input: 9, output: 1 }, { model: "test-luna" }), refused(429), refused(429));
    await runQueuedTests(env.DB, plugins(), NOW);
    const later = new Date("2026-11-27T10:03:00Z");
    // test-sonnet passes on its own row before the retest.
    plugin.replies.push(ok({ input: 9, output: 1 }, { model: "test-sonnet" }));
    await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-sonnet", now: later });
    const plan = await planRetest(env.DB, plugins(), userId, "openrouter");
    expect(plan.models.map((m) => m.model)).toEqual(["test-mini"]);
    expect(await startRetest(env.DB, plugins(), userId, "openrouter", later)).toEqual({ count: 1, skipped: 0 });
    const reopened = (await readTestAll(env.DB, userId, "openrouter"))!;
    expect(reopened.finishedAt).toBeUndefined();
    expect(reopened.retestCount).toBe(1);
    expect(reopened.tests.map((t) => [t.model, t.state])).toEqual([["test-luna", "passed"], ["test-mini", "queued"], ["test-sonnet", "failed"]]);
    plugin.replies.push(ok({ input: 9, output: 1 }, { model: "test-mini" }));
    await runQueuedTests(env.DB, plugins(), later);
    const done = (await readTestAll(env.DB, userId, "openrouter"))!;
    expect(done.finishedAt).toBe(later.toISOString());
    expect(done.tests.find((t) => t.model === "test-mini")?.state).toBe("passed");
    expect(await usable()).toEqual(["test-luna", "test-mini", "test-sonnet"]);
    expect((await planRetest(env.DB, plugins(), userId, "openrouter")).wait).toBe("Nothing failed in the last run.");
  });

  it("offers no Retest failed on a run made on an older model list", async () => {
    await startTestAll(env.DB, plugins(), userId, "openrouter", NOW);
    plugin.replies.push(refused(429), refused(429), refused(429));
    await runQueuedTests(env.DB, plugins(), NOW);
    await env.DB.prepare("UPDATE model_test_runs SET catalog_version = 2").run();
    expect((await planRetest(env.DB, plugins(), userId, "openrouter")).wait).toBe("The last run used the old model list.");
    expect(await startRetest(env.DB, plugins(), userId, "openrouter", NOW)).toEqual({ problem: "The last run used the old model list." });
  });

  it("never tests a model twice when two cron ticks overlap, and takes a stale claim again", async () => {
    await startTestAll(env.DB, plugins(), userId, "openrouter", NOW);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slow = { ...plugin, call: async (input: Parameters<TestPlugin["call"]>[0]) => (await held, plugin.call(input)) };
    const first = runQueuedTests(env.DB, { openrouter: slow }, NOW);
    await new Promise((r) => setTimeout(r, 50));
    expect(await runQueuedTests(env.DB, plugins(), NOW)).toBe(0);
    release();
    expect(await first).toBe(3);
    expect(plugin.calls.length).toBe(3);
    expect((await readTestAll(env.DB, userId, "openrouter"))!.finishedAt).toBe(NOW.toISOString());

    await env.DB.prepare("UPDATE model_tests SET state = 'running', claimed_at = ?").bind(NOW.toISOString()).run();
    await env.DB.prepare("UPDATE model_test_runs SET finished_at = NULL").run();
    expect(await runQueuedTests(env.DB, plugins(), new Date("2026-11-27T10:05:00Z"))).toBe(0);
    expect(await runQueuedTests(env.DB, plugins(), new Date("2026-11-27T10:11:00Z"))).toBe(3);
  });

  it("keeps one open run when two starts race", async () => {
    const [a, b] = await Promise.all([startTestAll(env.DB, plugins(), userId, "openrouter", NOW), startTestAll(env.DB, plugins(), userId, "openrouter", NOW)]);
    expect([a, b].filter((r) => "runId" in r)).toHaveLength(1);
    expect([a, b].filter((r) => "problem" in r)).toEqual([{ problem: "A test of all models is running already." }]);
    const { n } = (await env.DB.prepare("SELECT count(*) AS n FROM model_tests").first<{ n: number }>())!;
    expect(n).toBe(3);
  });

  it("runs one at a time and at most every ten minutes", async () => {
    await startTestAll(env.DB, plugins(), userId, "openrouter", NOW);
    expect(await startTestAll(env.DB, plugins(), userId, "openrouter", NOW)).toEqual({ problem: "A test of all models is running already." });
    await runQueuedTests(env.DB, plugins(), NOW);
    expect(await startTestAll(env.DB, plugins(), userId, "openrouter", new Date("2026-11-27T10:05:00Z"))).toEqual({ problem: "You can test all models again from 10:10 UTC." });
    expect(await startTestAll(env.DB, plugins(), userId, "openrouter", new Date("2026-11-27T10:10:00Z"))).toHaveProperty("runId");
  });

  it("takes at most a tick's share of tests at once", async () => {
    expect(PER_TICK).toBeGreaterThan(0);
    await startTestAll(env.DB, plugins(), userId, "openrouter", NOW);
    const before = (await readTestAll(env.DB, userId, "openrouter"))!;
    expect(before.done).toBe(0);
    expect(before.modelCount).toBe(3);
  });
});

describe("the model for each task", () => {
  // Two models of each strength the tasks take, one Strongest, one free and
  // one at $0 a token that is not free ("Other fees").
  const TIERED = {
    ...TEST_CATALOG,
    models: [
      ...TEST_CATALOG.models,
      { id: "test-mid", name: "Test Mid", tools: true },
      { id: "test-mid2", name: "Test Mid Two", tools: true },
      { id: "test-free:free", name: "Test Free", tools: true, free: true as const },
      { id: "test-fee", name: "Test Fee", tools: true },
    ],
  };
  const tieredPrices = () =>
    writeSnapshot(env.DB, {
      takenAt: "2026-11-27T07:00:00Z", status: "good", results: [], catalog: TIERED,
      rows: [
        row("test-luna", "input", 0.1), row("test-luna", "output", 0.5), row("test-mini", "input", 0.25), row("test-mini", "output", 1),
        row("test-mid", "input", 1), row("test-mid", "output", 4), row("test-mid2", "input", 2), row("test-mid2", "output", 8),
        row("test-sonnet", "input", 3), row("test-sonnet", "output", 15), row("test-free:free", "input", 0), row("test-free:free", "output", 0),
        row("test-fee", "input", 0), row("test-fee", "output", 0),
      ],
    });
  const passAll = async (...models: string[]) => { for (const m of models) await recordTest(userId, m); };
  const page = async (extra: Partial<PickerPageInput> = {}) => {
    const { offered, routes } = await readTaskRoutes(env.DB, userId);
    return renderPickerPage({ viewer: "owner", offered, routes, providerName: () => "OpenRouter", noToolUse: () => false, nameOf: await readModelNames(env.DB), ...extra });
  };
  // A task's row, and the values its plain select offers for `role`.
  const rowOf = (html: string, task: string) => html.match(new RegExp(`<li class="task" id="task-${task}"[\\s\\S]*?</form></li>`))![0];
  const optionsOf = (html: string, role: string, task: string) =>
    [...html.match(new RegExp(`<select class="nsel" id="${role}-${task}"[^>]*>([\\s\\S]*?)</select>`))![1]!.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
  const listOf = (html: string, role: string, task: string) =>
    [...html.match(new RegExp(`<ul role="listbox" id="pl-${role}-${task}"[^>]*>([\\s\\S]*?)</ul>`))![1]!.matchAll(/data-value="([^"]*)"/g)].map((m) => m[1]);
  const or = (m: string) => `openrouter|${m}`;
  const m = (model: string, tier: Offered["tier"], inputUsd: number, free = false): Offered => ({
    provider: "openrouter", model, location: "global", testedAt: "", test: { at: "", location: "global", status: 200, costUsd: 0 }, tier, inputUsd, free,
  });

  it("offers each task only the usable models whose strength chip is its own, the cheapest first", async () => {
    await tieredPrices();
    await passAll("test-luna", "test-mini", "test-mid", "test-mid2", "test-sonnet", "test-free:free", "test-fee");
    // test-mini fails a later test: no longer usable, so offered nowhere.
    await recordTest(userId, "test-mini", "failed", "2026-11-27T11:00:00.000Z");
    const { offered } = await readTaskRoutes(env.DB, userId);
    expect(offered.find((x) => x.model === "test-fee")).toMatchObject({ otherFees: true });
    expect(offered.find((x) => x.model === "test-fee")).not.toHaveProperty("tier");
    expect(offered.find((x) => x.model === "test-free:free")).toMatchObject({ tier: "Smallest", free: true, inputUsd: 0, outputUsd: 0, name: "Test Free" });
    expect(offeredFor(taskById("match")!, offered).map((x) => x.model)).toEqual(["test-free:free", "test-luna"]);
    expect(offeredFor(taskById("score")!, offered).map((x) => x.model)).toEqual(["test-mid", "test-mid2"]);
    const html = await page();
    for (const task of TASKS) {
      const want = task.tier === "Smallest" ? [or("test-free:free"), or("test-luna")] : [or("test-mid"), or("test-mid2")];
      expect(listOf(html, "main", task.id)).toEqual(want);
      expect(listOf(html, "fallback", task.id)).toEqual(["", ...want]);
      expect(optionsOf(html, "main", task.id).filter(Boolean)).toEqual(want);
    }
    // Each model reads as its row does: name, ID, price per million tokens, or Free.
    expect(rowOf(html, "score")).toContain('<span class="ov-nm">Test Mid</span><span class="ov-pr num">$1.00 / $4.00</span></span><span class="ov-l2"><span class="ov-id">test-mid</span>');
    expect(rowOf(html, "match")).toContain(`<span class="ov-nm">Test Free</span><span class="pill free" title="${FREE_NOTE}">Free</span>`);
    expect(rowOf(html, "match")).toContain(`Test Free · test-free:free · ${FREE_NOTE}`);
    expect(html).not.toContain("test-sonnet");
    expect(html).not.toContain("test-fee");
  });

  it("proposes the two cheapest models of the task's own strength, never another strength or a free model", () => {
    const models = [m("a", "Middle", 1), m("b", "Middle", 2), m("c", "Smallest", 0.1), m("s", "Strongest", 3), m("f", "Smallest", 0, true)];
    const route = proposeRoute(taskById("score")!, models);
    expect([route?.main.model, route?.fallback?.model]).toEqual(["a", "b"]);
    const single = proposeRoute(taskById("match")!, models);
    expect([single?.main.model, single?.fallback]).toEqual(["c", undefined]);
    // Only Smallest models: a Middle task gets no proposal, not a Smallest one.
    expect(proposeRoute(taskById("score")!, [m("c", "Smallest", 0.1), m("d", "Smallest", 0.2)])).toBeUndefined();
    expect(proposeRoute(taskById("match")!, [m("f", "Smallest", 0, true)])).toBeUndefined();
    expect(proposeRoute(taskById("match")!, [m("f", "Smallest", 0, true), m("g", "Smallest", 0, true)], true)).toMatchObject({ main: { model: "f" }, fallback: { model: "g" } });
  });

  it("never proposes a free model, and saves one the user chooses for a task of its strength only", async () => {
    await tieredPrices();
    await passAll("test-free:free");
    expect(await routeTask(env.DB, userId, "match")).toBeUndefined();
    const first = (await readTaskRoutes(env.DB, userId)).routes[0]!;
    expect([first.current, first.proposal, first.pending]).toEqual([undefined, undefined, false]);
    expect(await changeTasks(env.DB, userId, [{ task: "score", main: or("test-free:free"), fallback: "" }], NOW)).toEqual({ task: "score", problem: "wrong_strength" });
    expect(await changeTasks(env.DB, userId, [{ task: "match", main: or("test-free:free"), fallback: "" }], NOW)).toBeUndefined();
    expect(await routeTask(env.DB, userId, "match")).toMatchObject({ main: { model: "test-free:free" } });
  });

  it("saves changes all or none, refuses a model of another strength, an untested one or the main as its own fallback, and calls the fallback on a 429", async () => {
    await tieredPrices();
    await passAll("test-luna", "test-mini", "test-mid", "test-sonnet");
    const change = (task: string, main: string, fallback = "") => ({ task, main: main && or(main), fallback: fallback && or(fallback) });
    expect(await changeTasks(env.DB, userId, [change("match", "test-luna", "test-luna")], NOW)).toEqual({ task: "match", problem: "same_model" });
    expect(await changeTasks(env.DB, userId, [change("match", "test-mid2")], NOW)).toEqual({ task: "match", problem: "not_your_model" });
    expect(await changeTasks(env.DB, userId, [change("score", "test-sonnet")], NOW)).toEqual({ task: "score", problem: "wrong_strength" });
    expect(await changeTasks(env.DB, userId, [change("score", "test-mid", "test-luna")], NOW)).toEqual({ task: "score", problem: "wrong_strength" });
    expect(await changeTasks(env.DB, userId, [change("match", "")], NOW)).toEqual({ task: "match", problem: "no_main" });
    expect(await changeTasks(env.DB, userId, [change("nope", "test-luna")], NOW)).toEqual({ task: "nope", problem: "no_such_task" });
    // One refused change saves none of them.
    expect(await changeTasks(env.DB, userId, [change("extract", "test-luna"), change("score", "test-sonnet")], NOW)).toEqual({ task: "score", problem: "wrong_strength" });
    expect(await routeTask(env.DB, userId, "extract")).toBeUndefined();
    expect(await changeTasks(env.DB, userId, [change("match", "test-luna", "test-mini"), change("score", "test-mid")], NOW)).toBeUndefined();
    expect(await routeTask(env.DB, userId, "match")).toMatchObject({ main: { model: "test-luna" }, fallback: { model: "test-mini" } });
    expect(await routeTask(env.DB, userId, "score")).toMatchObject({ main: { model: "test-mid" } });
    await setBudget(env.DB, userId, "openrouter", 5, "typed", NOW);
    plugin.replies.push(refused(429), ok({ input: 1, output: 1 }));
    expect(await callTask(env.DB, plugins(), { userId, task: "match", request: () => ({}) }, () => NOW)).toMatchObject({ kind: "answered", model: "test-mini", fallback: true });
  });

  it("keeps a saved choice of another strength running and shows it as it is, and lets one role change without the other", async () => {
    await tieredPrices();
    await passAll("test-mid", "test-mid2", "test-sonnet");
    await env.DB.prepare("INSERT INTO task_routes (user_id, task, main_provider, main_model, fallback_provider, fallback_model, set_how, set_at) VALUES (?, 'score', 'openrouter', 'test-sonnet', NULL, NULL, 'changed', ?)").bind(userId, NOW.toISOString()).run();
    expect(await routeTask(env.DB, userId, "score")).toMatchObject({ main: { model: "test-sonnet" } });
    const html = await page();
    const score = rowOf(html, "score");
    expect(score).toContain('<span class="ov-nm">Test Sonnet</span><span class="ov-pr num">$3.00 / $15.00</span></span><span class="ov-l2"><span class="ov-id">test-sonnet</span><span class="pill">Strongest</span>');
    expect(score).toContain('<span data-about="main">Its main model is a Strongest model, kept from before.</span>');
    // Its plain select keeps it, the list offers only Middle models.
    expect(optionsOf(html, "main", "score")).toEqual([or("test-sonnet"), or("test-mid"), or("test-mid2")]);
    expect(listOf(html, "main", "score")).toEqual([or("test-mid"), or("test-mid2")]);
    // A fallback added beside the kept main model saves; the kept model may not be chosen for another task.
    expect(await changeTasks(env.DB, userId, [{ task: "score", main: or("test-sonnet"), fallback: or("test-mid") }], NOW)).toBeUndefined();
    expect(await routeTask(env.DB, userId, "score")).toMatchObject({ main: { model: "test-sonnet" }, fallback: { model: "test-mid" } });
    expect(await changeTasks(env.DB, userId, [{ task: "fill_form", main: or("test-sonnet"), fallback: "" }], NOW)).toEqual({ task: "fill_form", problem: "wrong_strength" });
  });

  it("accepts every proposal with one tap, only where the task's own strength has models", async () => {
    await passAll("test-luna", "test-mini");
    const smallest = TASKS.filter((t) => t.tier === "Smallest").length;
    expect(await acceptProposals(env.DB, userId, NOW)).toBe(smallest);
    const { routes } = await readTaskRoutes(env.DB, userId);
    expect(routes.find((r) => r.task.id === "match")?.current).toMatchObject({ main: { model: "test-luna" }, fallback: { model: "test-mini" }, setHow: "accepted" });
    expect(routes.find((r) => r.task.id === "score")).toMatchObject({ proposal: undefined, pending: false });
    expect(routes.find((r) => r.task.id === "score")!.current).toBeUndefined();
  });

  it("keeps a task's model while its latest test passed; once it fails, the task runs on its named fallback, or has no model with none", async () => {
    await passAll("test-luna", "test-mini");
    await changeTasks(env.DB, userId, [{ task: "match", main: or("test-luna"), fallback: or("test-mini") }, { task: "extract", main: or("test-luna"), fallback: "" }], NOW);
    await setBudget(env.DB, userId, "openrouter", 5, "typed", NOW);
    expect(await routeTask(env.DB, userId, "match")).toMatchObject({ main: { model: "test-luna" }, fallback: { model: "test-mini" } });
    // test-luna fails a later test.
    await recordTest(userId, "test-luna", "failed", "2026-11-27T11:00:00.000Z");
    const { routes } = await readTaskRoutes(env.DB, userId);
    const match = routes.find((r) => r.task.id === "match")!;
    expect(match).toMatchObject({ stopped: { main: { provider: "openrouter", model: "test-luna" }, fallback: { model: "test-mini" } }, pending: false });
    expect(match.current).toBeUndefined();
    expect(routes.find((r) => r.task.id === "extract")).toMatchObject({ stopped: { main: { model: "test-luna" } }, pending: false });
    expect(routes.find((r) => r.task.id === "extract")!.stopped!.fallback).toBeUndefined();
    // The other Smallest task's proposal is taken first: Accept would be the one solid button.
    await acceptProposals(env.DB, userId, NOW);
    const html = await page({ nameOf: (x) => (x.model === "test-luna" ? "Test Luna" : undefined) });
    // The saved model is still shown, marked, with why and the fix.
    const fix = `<a class="btn small" href="/chief-of-staff/models/setup/providers?provider=openrouter#m-test-luna">Test it again</a>`;
    expect(rowOf(html, "match")).toContain('<span class="ov-nm">Test Luna</span></span><span class="ov-l2"><span class="ov-id">test-luna</span><span class="pill bad">Not usable</span>');
    expect(rowOf(html, "match")).toContain(`<p class="t-says"><span data-about="main">Test Luna failed its last test. Runs on its fallback for now.</span></p><span class="t-act" data-about="main">${fix}</span>`);
    // With no fallback the task has no model: its fix is the page's one solid button.
    expect(rowOf(html, "extract")).toContain(`<span data-about="main">Test Luna failed its last test. No model now: its calls are refused.</span></p><span class="t-act" data-about="main">${fix.replace('class="btn small"', 'class="btn small primary"')}</span>`);
    // The save bar's Save, hidden until a row changes, aside.
    expect(html.match(/class="btn[^"]* primary"(?! data-save)/g)).toHaveLength(1);
    // A call goes to the saved fallback, never to another model.
    expect(await routeTask(env.DB, userId, "match")).toEqual({ main: expect.objectContaining({ model: "test-mini" }) });
    plugin.replies.push(ok({ input: 1, output: 1 }));
    expect(await callTask(env.DB, plugins(), { userId, task: "match", request: () => ({}) }, () => NOW)).toMatchObject({ kind: "answered", model: "test-mini" });
    // With no usable fallback the call is refused with a plain reason, even
    // though another model is usable.
    expect(await routeTask(env.DB, userId, "extract")).toBeUndefined();
    const before = plugin.calls.length;
    expect(await callTask(env.DB, plugins(), { userId, task: "extract", request: () => ({}) }, () => NOW)).toMatchObject({ kind: "no_model", task: "extract", detail: expect.stringMatching(/test its model again/) });
    expect(plugin.calls.length).toBe(before);
    // One tap never replaces the choice by itself.
    await acceptProposals(env.DB, userId, NOW);
    expect(await routeTask(env.DB, userId, "extract")).toBeUndefined();
    // It works again once its model passes again.
    await recordTest(userId, "test-luna", "passed", "2026-11-27T12:00:00.000Z");
    expect(await routeTask(env.DB, userId, "extract")).toMatchObject({ main: { model: "test-luna" } });
  });

  it("says why a saved model is no longer usable, by the same checks that decide it, with the action that fixes it", async () => {
    await savePriceCap(env.DB, userId, "openrouter", "openrouter/auto", { input: 0.3, output: 1 }, NOW);
    for (const model of ["test-luna", "test-mini", "openrouter/auto"]) await recordTest(userId, model);
    const route = (task: string, main: string, fallback = "test-mini") =>
      env.DB.prepare("INSERT INTO task_routes (user_id, task, main_provider, main_model, fallback_provider, fallback_model, set_how, set_at) VALUES (?, ?, 'openrouter', ?, 'openrouter', ?, 'changed', ?)").bind(userId, task, main, fallback, NOW.toISOString());
    await env.DB.batch([
      route("match", "test-luna"),
      route("extract", "test-sonnet"),
      route("linkedin_message", "openrouter/auto"),
      route("score", "test-new"),
      // OpenRouter stops listing test-luna, and lists test-new, never tested.
      env.DB.prepare("DELETE FROM model_price_caps"),
      env.DB.prepare("INSERT INTO provider_model_lists (user_id, provider, read_at, models) VALUES (?, 'openrouter', ?, ?)")
        .bind(userId, NOW.toISOString(), JSON.stringify(["openrouter/auto", "test-mini", "test-new"])),
    ]);
    await writeSnapshot(env.DB, {
      takenAt: "2026-11-27T11:00:00Z", status: "good", results: [],
      catalog: { ...TEST_CATALOG, models: [...TEST_CATALOG.models.filter((x) => x.id !== "test-luna"), { id: "test-new", name: "Test New", tools: true }] },
      rows: [row("test-mini", "input", 0.25), row("test-mini", "output", 1), row("test-new", "input", 0.1), row("test-new", "output", 0.5), row("test-sonnet", "input", 3), row("test-sonnet", "output", 15)],
    });
    const { routes } = await readTaskRoutes(env.DB, userId);
    const why = (task: string) => routes.find((r) => r.task.id === task)!.stopped?.why;
    expect([why("match"), why("extract"), why("linkedin_message"), why("score")]).toEqual(["not_listed", "left_out", "no_cap", "unknown"]);
    const html = await page({ accountSettings: () => ({ label: "Privacy settings", href: "https://example.com/privacy" }) });
    const says = (task: string) => rowOf(html, task).match(/<div class="t-note">([\s\S]*?)<button type="submit"/)![1]!;
    const on = (text: string, fix: string) => `<p class="t-says"><span data-about="main">${text} Runs on its fallback for now.</span></p><span class="t-act" data-about="main">${fix}</span>`;
    expect(says("match")).toBe(on("test-luna is no longer on OpenRouter&#39;s list.", `<a class="btn small" href="#main-match" data-open="main-match">Choose another</a>`));
    expect(says("extract")).toBe(on("Test Sonnet is left out by your OpenRouter settings.", `<a class="btn small ext" href="https://example.com/privacy" target="_blank" rel="noopener noreferrer">Privacy settings</a>`));
    expect(says("linkedin_message")).toBe(on("Auto router needs a price cap.", `<a class="btn small" href="/chief-of-staff/models/setup/providers?provider=openrouter&amp;cap=openrouter%2Fauto#m-openrouter-auto">Set its price cap</a>`));
    // A Middle task with a Smallest fallback kept from before still runs on it.
    expect(says("score")).toContain("Test New is no longer usable.");
    // Each still answers on its fallback.
    expect(await routeTask(env.DB, userId, "linkedin_message")).toEqual({ main: expect.objectContaining({ model: "test-mini" }) });
  });

  it("shows a saved fallback that is no longer usable, with why and its fix, while the main model runs alone", async () => {
    await passAll("test-luna", "test-mini");
    await changeTasks(env.DB, userId, [{ task: "match", main: or("test-luna"), fallback: or("test-mini") }], NOW);
    await recordTest(userId, "test-mini", "failed", "2026-11-27T11:00:00.000Z");
    const { routes } = await readTaskRoutes(env.DB, userId);
    expect(routes[0]).toMatchObject({ current: { main: { model: "test-luna" }, fallback: undefined }, fallbackGone: { model: "test-mini", why: "failed" } });
    expect(await routeTask(env.DB, userId, "match")).toEqual({ main: expect.objectContaining({ model: "test-luna" }) });
    const html = await page();
    expect(rowOf(html, "match")).toContain('<span class="ov-id">test-mini</span><span class="pill bad">Not usable</span>');
    expect(rowOf(html, "match")).toContain('<span data-about="fallback">Its fallback Test Mini failed its last test.</span></p><span class="t-act" data-about="fallback"><a class="btn small" href="/chief-of-staff/models/setup/providers?provider=openrouter#m-test-mini">Test it again</a>');
  });

  it("says in a strength's rows when it has no usable model, with a link to its models not tested yet on Providers", async () => {
    await tieredPrices();
    await passAll("test-luna");
    const toTest = { provider: "openrouter" as const, connected: true, untested: { Middle: 2 } };
    const html = await page({ toTest });
    const link = `href="/chief-of-staff/models/setup/providers?provider=openrouter&amp;strength=Middle&amp;show=pending#test">Test Middle models</a>`;
    expect(rowOf(html, "score")).toContain(`<p class="t-says"><span>No Middle model has passed a test yet.</span></p><span class="t-act"><a class="btn small" ${link}`);
    expect(rowOf(html, "score")).toContain('<button type="button" class="pick-btn" id="pb-main-score" aria-haspopup="listbox" aria-expanded="false" aria-controls="pl-main-score" aria-labelledby="lbl-main-score pb-main-score" disabled>');
    // The tap comes first; once it is taken, the first such row's link is the one solid button.
    expect(html).toContain('<button type="submit" class="btn primary">Accept all with one tap</button>');
    await acceptProposals(env.DB, userId, NOW);
    const after = await page({ toTest });
    expect(rowOf(after, "score")).toContain(`<a class="btn small primary" ${link}`);
    expect(rowOf(after, "fill_form")).toContain(`<a class="btn small" ${link}`);
    // Every Middle model tested already: the link shows them all; not connected: Connect.
    expect(await page({ toTest: { ...toTest, untested: {} } })).toContain('href="/chief-of-staff/models/setup/providers?provider=openrouter&amp;strength=Middle#test">See Middle models</a>');
    expect(await page({ toTest: { ...toTest, connected: false } })).toContain('href="/chief-of-staff/models/setup/providers">Connect OpenRouter</a>');
    // The count comes from the strength chips of the models the user can still test.
    expect(await readToTest(env.DB, plugins(), userId)).toEqual({ provider: "openrouter", connected: true, untested: { Smallest: 2, Middle: 2, Strongest: 1 } });
  });

  it("gives a task with no saved choice no model, even with one usable model, and says to choose one", async () => {
    await recordTest(userId, "test-luna");
    expect(await routeTask(env.DB, userId, "extract")).toBeUndefined();
    const { routes } = await readTaskRoutes(env.DB, userId);
    const extract = routes.find((r) => r.task.id === "extract")!;
    expect(extract.current).toBeUndefined();
    expect(extract).toMatchObject({ proposal: { main: { model: "test-luna" } }, pending: true });
    const html = await page();
    expect(rowOf(html, "extract")).toContain('<span class="pill">Proposed</span>');
    expect(html).toContain("Accept all with one tap");
    expect(await callTask(env.DB, plugins(), { userId, task: "extract", request: () => ({}) }, () => NOW)).toEqual({
      kind: "no_model",
      task: "extract",
      detail: "no model chosen for this task: choose one for it on Models › Setup › Model for each task (/chief-of-staff/models/setup/tasks)",
    });
    expect(plugin.calls).toEqual([]);
  });

  it("saves in place with the page's <main> as JSON, or redirects back without the script, and keeps the choices on a refusal", async () => {
    await passAll("test-luna", "test-mini");
    const post = (fields: Array<[string, string]>, json: boolean) =>
      handleTaskModels(
        new Request(`${ORIGIN}${TASK_MODELS_PATH}/change`, { method: "POST", headers: { origin: ORIGIN, ...(json ? { accept: "application/json" } : {}) }, body: new URLSearchParams(fields) }),
        { db: env.DB, plugins: plugins(), userId, viewer: "owner", now: NOW },
      );
    const inPlace = await post([["task", "match"], ["main.match", or("test-mini")], ["fallback.match", or("test-luna")], ["task", "extract"], ["main.extract", or("test-luna")], ["fallback.extract", ""]], true);
    expect(inPlace.status).toBe(200);
    const body = (await inPlace.json()) as { main: string };
    expect(body.main).toContain('<div class="banner ok" role="status" tabindex="-1">Saved: 2 tasks.</div>');
    expect(body.main).not.toContain("<html");
    expect(await routeTask(env.DB, userId, "match")).toMatchObject({ main: { model: "test-mini" }, fallback: { model: "test-luna" } });
    const refused = await post([["task", "match"], ["main.match", or("test-luna")], ["fallback.match", or("test-luna")]], true);
    expect([refused.status, await refused.json()]).toEqual([400, { problem: "Matching questions: The fallback must be another model than the main one." }]);
    const plain = await post([["task", "extract"], ["main.extract", or("test-mini")], ["fallback.extract", ""]], false);
    expect([plain.status, plain.headers.get("location")]).toEqual([303, `${ORIGIN}${TASK_MODELS_PATH}?saved=extract`]);
    const back = await (await handleTaskModels(new Request(plain.headers.get("location")!), { db: env.DB, plugins: plugins(), userId, viewer: "owner", now: NOW })).text();
    expect(back).toContain("Saved: Extracting facts.");
    const plainRefused = await post([["task", "score"], ["main.score", or("test-luna")], ["fallback.score", ""]], false);
    expect(plainRefused.headers.get("location")).toBe(`${ORIGIN}${TASK_MODELS_PATH}?problem=wrong_strength&task=score`);
    expect(await (await handleTaskModels(new Request(plainRefused.headers.get("location")!), { db: env.DB, plugins: plugins(), userId, viewer: "owner", now: NOW })).text()).toContain("Scoring roles: This task takes only Middle models. Choose one from its list.");
    // A form from another site is refused.
    const foreign = await handleTaskModels(new Request(`${ORIGIN}${TASK_MODELS_PATH}/change`, { method: "POST", headers: { origin: "https://evil.example" }, body: new URLSearchParams([["task", "match"]]) }), { db: env.DB, plugins: plugins(), userId, viewer: "owner", now: NOW });
    expect(foreign.status).toBe(403);
  });

  it("saves the rows changed and not saved with a tap, as the user chose them, all or none, and taps only the others", async () => {
    await passAll("test-luna", "test-mini");
    const post = (verb: string, fields: Array<[string, string]>, json: boolean) =>
      handleTaskModels(
        new Request(`${ORIGIN}${TASK_MODELS_PATH}/${verb}`, { method: "POST", headers: { origin: ORIGIN, ...(json ? { accept: "application/json" } : {}) }, body: new URLSearchParams(fields) }),
        { db: env.DB, plugins: plugins(), userId, viewer: "owner", now: NOW },
      );
    const saved = async () => (await env.DB.prepare("SELECT task, main_model, fallback_model, set_how FROM task_routes WHERE user_id = ? ORDER BY task").bind(userId).all()).results;
    // A refused change saves nothing, and takes no proposal either.
    for (const verb of ["accept", "use-free"]) {
      const refused = await post(verb, [["task", "match"], ["main.match", or("test-mini")], ["fallback.match", ""], ["task", "score"], ["main.score", or("test-luna")], ["fallback.score", ""]], true);
      expect([refused.status, await refused.json()]).toEqual([400, { problem: "Scoring roles: This task takes only Middle models. Choose one from its list." }]);
    }
    expect(await saved()).toEqual([]);
    // Matching questions is proposed test-luna with test-mini; the user chose test-mini alone.
    const res = await post("accept", [["task", "match"], ["main.match", or("test-mini")], ["fallback.match", ""]], true);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { main: string }).main).toContain("Saved: Matching questions. Accepted: 2 tasks use their proposed models.");
    expect(await saved()).toEqual([
      { task: "extract", main_model: "test-luna", fallback_model: "test-mini", set_how: "accepted" },
      { task: "linkedin_message", main_model: "test-luna", fallback_model: "test-mini", set_how: "accepted" },
      { task: "match", main_model: "test-mini", fallback_model: null, set_how: "changed" },
    ]);
    // Without the script a tap posts no rows, and says what it did in the address.
    const plain = await post("accept", [], false);
    expect([plain.status, plain.headers.get("location")]).toEqual([303, `${ORIGIN}${TASK_MODELS_PATH}?accepted=0`]);
  });
});
