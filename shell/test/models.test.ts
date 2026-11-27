import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { FREE_NOTE, listOffer, namesPickedModel, testOne, blockKind } from "../src/models/test-model";
import { readLatestTests, readUsableModels } from "../src/models/usable";
import { parsePriceCap, savePriceCap } from "../src/models/price-caps";
import { renderPickerPage, handleTaskModels } from "../src/models/picker-page";
import { acceptProposals, callTask, changeTask, proposeRoute, readTaskRoutes, routeTask, taskById, type Offered } from "../src/models/tasks";
import { ESTIMATE_INPUT_TOKENS, planRetest, planTestAll, PER_TICK, readTestAll, runQueuedTests, shownTests, startRetest, startTestAll } from "../src/models/test-all";
import { classify, TEST_MAX_TOKENS } from "../src/providers/openrouter";
import { formatCost, modelParts, type ModelsTableInput } from "../src/providers/models-table";
import { setBudget } from "../src/proxy/budgets";
import { writeConnection } from "../src/proxy/connections";
import { writeSnapshot } from "../src/prices/store";
import { ok, recordTest, refused, row, seedPrices, TEST_CATALOG, testPlugin, userFor, type TestPlugin } from "./test-plugin";

const NOW = new Date("2026-11-27T10:00:00Z");
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
  const m = (model: string, tier: Offered["tier"], inputUsd: number): Offered => ({
    provider: "openrouter", model, location: "global", testedAt: "", test: { at: "", location: "global", status: 200, costUsd: 0 }, tier, inputUsd,
  });

  it("proposes a fallback that is another model on the same provider, never the main one", async () => {
    const route = proposeRoute(taskById("score")!, [m("a", "Middle", 1), m("b", "Middle", 2), m("c", "Smallest", 0.1)]);
    expect([route?.main.model, route?.fallback?.model]).toEqual(["a", "b"]);
    const single = proposeRoute(taskById("match")!, [m("c", "Smallest", 0.1)]);
    expect(single?.fallback).toBeUndefined();
  });

  it("never proposes a free model until it is chosen with Change", async () => {
    await writeSnapshot(env.DB, {
      takenAt: "2026-11-27T07:00:00Z", status: "good", results: [],
      catalog: { ...TEST_CATALOG, models: [...TEST_CATALOG.models, { id: "test-free:free", name: "Test Free", tools: true, free: true }] },
      rows: [row("test-luna", "input", 0.1), row("test-luna", "output", 0.5), row("test-free:free", "input", 0), row("test-free:free", "output", 0)],
    });
    expect((await listOffer(env.DB, plugins(), userId, "openrouter")).find((r) => r.model === "test-free:free")?.notes).toEqual([FREE_NOTE]);
    await recordTest(userId, "test-free:free");
    expect(await routeTask(env.DB, userId, "match")).toBeUndefined();
    const first = (await readTaskRoutes(env.DB, userId)).routes[0]!;
    expect([first.current, first.proposal, first.pending]).toEqual([undefined, undefined, false]);
    await recordTest(userId, "test-luna");
    const { offered, routes } = await readTaskRoutes(env.DB, userId);
    expect(routes.every((r) => r.proposal?.main.model === "test-luna" && r.proposal.fallback === undefined)).toBe(true);
    const html = renderPickerPage({ viewer: "owner", offered, routes, providerName: () => "OpenRouter", noToolUse: () => false });
    expect(html).toContain(`test-free:free · ${FREE_NOTE}`);
    expect(await changeTask(env.DB, userId, "match", "openrouter|test-free:free", undefined, NOW)).toBeUndefined();
    expect(await routeTask(env.DB, userId, "match")).toMatchObject({ main: { model: "test-free:free" } });
  });

  it("saves a change naming provider and model, refuses the same model as its own fallback, and calls the fallback on a 429", async () => {
    await recordTest(userId, "test-luna");
    await recordTest(userId, "test-mini");
    expect(await changeTask(env.DB, userId, "match", "openrouter|test-luna", "openrouter|test-luna", NOW)).toBe("same_model");
    expect(await changeTask(env.DB, userId, "match", "openrouter|test-sonnet", undefined, NOW)).toBe("not_your_model");
    expect(await changeTask(env.DB, userId, "match", "openrouter|test-luna", "openrouter|test-mini", NOW)).toBeUndefined();
    expect(await routeTask(env.DB, userId, "match")).toMatchObject({ main: { model: "test-luna" }, fallback: { model: "test-mini" } });
    await setBudget(env.DB, userId, "openrouter", 5, "typed", NOW);
    plugin.replies.push(refused(429), ok({ input: 1, output: 1 }));
    expect(await callTask(env.DB, plugins(), { userId, task: "match", request: () => ({}) }, () => NOW)).toMatchObject({ kind: "answered", model: "test-mini", fallback: true });
  });

  it("accepts every proposal with one tap", async () => {
    await recordTest(userId, "test-luna");
    await recordTest(userId, "test-mini");
    expect(await acceptProposals(env.DB, userId, NOW)).toBe(8);
    const { routes } = await readTaskRoutes(env.DB, userId);
    expect(routes.find((r) => r.task.id === "match")?.current).toMatchObject({ main: { model: "test-luna" }, fallback: { model: "test-mini" }, setHow: "accepted" });
  });

  it("keeps a task's model while its latest test passed; once it fails, the task runs on its named fallback, or reads Choose a model with none", async () => {
    await recordTest(userId, "test-luna");
    await recordTest(userId, "test-mini");
    await recordTest(userId, "test-sonnet");
    await changeTask(env.DB, userId, "match", "openrouter|test-luna", "openrouter|test-mini", NOW);
    await changeTask(env.DB, userId, "score", "openrouter|test-luna", undefined, NOW);
    await setBudget(env.DB, userId, "openrouter", 5, "typed", NOW);
    expect(await routeTask(env.DB, userId, "match")).toMatchObject({ main: { model: "test-luna" }, fallback: { model: "test-mini" } });
    // test-luna fails a later test.
    await recordTest(userId, "test-luna", "failed", "2026-11-27T11:00:00.000Z");
    const { offered, routes } = await readTaskRoutes(env.DB, userId);
    const match = routes.find((r) => r.task.id === "match")!;
    expect(match).toMatchObject({ stopped: { main: { provider: "openrouter", model: "test-luna" }, fallback: { model: "test-mini" } }, pending: false });
    expect(match.current).toBeUndefined();
    expect(routes.find((r) => r.task.id === "score")).toMatchObject({ stopped: { main: { model: "test-luna" } }, pending: false });
    expect(routes.find((r) => r.task.id === "score")!.stopped!.fallback).toBeUndefined();
    const html = renderPickerPage({ viewer: "owner", offered, routes, providerName: () => "OpenRouter", noToolUse: () => false });
    expect(html).toMatch(
      /<td data-l="Task">Matching questions<\/td>[\s\S]*?<td data-l="Main">Runs on its fallback for now: test-luna failed its last test\. Choose a new main model with Change\.<\/td><td data-l="Fallback \(another model\)">test-mini · OpenRouter<\/td>\s*<td data-l=""><details class="change" open>/,
    );
    expect(html).toMatch(/<td data-l="Task">Scoring roles<\/td>[\s\S]*?<td data-l="Main">Choose a model <span class="small">test-luna failed its last test\.<\/span><\/td>[\s\S]*?<details class="change">/);
    // A call goes to the saved fallback, never to another model.
    expect(await routeTask(env.DB, userId, "match")).toEqual({ main: expect.objectContaining({ model: "test-mini" }) });
    plugin.replies.push(ok({ input: 1, output: 1 }));
    expect(await callTask(env.DB, plugins(), { userId, task: "match", request: () => ({}) }, () => NOW)).toMatchObject({ kind: "answered", model: "test-mini" });
    // With no usable fallback the call is refused with a plain reason, even
    // though another model is usable.
    expect(await routeTask(env.DB, userId, "score")).toBeUndefined();
    const before = plugin.calls.length;
    expect(await callTask(env.DB, plugins(), { userId, task: "score", request: () => ({}) }, () => NOW)).toMatchObject({ kind: "no_model", task: "score", detail: expect.stringMatching(/test its model again/) });
    expect(plugin.calls.length).toBe(before);
    // One tap never replaces the choice by itself.
    await acceptProposals(env.DB, userId, NOW);
    expect(await routeTask(env.DB, userId, "score")).toBeUndefined();
    // It works again once its model passes again.
    await recordTest(userId, "test-luna", "passed", "2026-11-27T12:00:00.000Z");
    expect(await routeTask(env.DB, userId, "score")).toMatchObject({ main: { model: "test-luna" } });
  });

  it("says why a task's main model is no longer usable, by the same checks that decide it", async () => {
    await savePriceCap(env.DB, userId, "openrouter", "openrouter/auto", { input: 3, output: 15 }, NOW);
    for (const model of ["test-luna", "test-mini", "openrouter/auto"]) await recordTest(userId, model);
    const route = (task: string, main: string) =>
      env.DB.prepare("INSERT INTO task_routes (user_id, task, main_provider, main_model, fallback_provider, fallback_model, set_how, set_at) VALUES (?, ?, 'openrouter', ?, 'openrouter', 'test-mini', 'changed', ?)").bind(userId, task, main, NOW.toISOString());
    await env.DB.batch([
      route("match", "test-luna"),
      route("score", "test-sonnet"),
      route("fill_form", "openrouter/auto"),
      route("check_form", "test-new"),
      // OpenRouter stops listing test-luna, and lists test-new, never tested.
      env.DB.prepare("DELETE FROM model_price_caps"),
      env.DB.prepare("INSERT INTO provider_model_lists (user_id, provider, read_at, models) VALUES (?, 'openrouter', ?, ?)")
        .bind(userId, NOW.toISOString(), JSON.stringify(["openrouter/auto", "test-mini", "test-new"])),
    ]);
    await writeSnapshot(env.DB, {
      takenAt: "2026-11-27T11:00:00Z", status: "good", results: [],
      catalog: { ...TEST_CATALOG, models: [...TEST_CATALOG.models.filter((m) => m.id !== "test-luna"), { id: "test-new", name: "Test New", tools: true }] },
      rows: [row("test-mini", "input", 0.25), row("test-mini", "output", 1), row("test-new", "input", 0.1), row("test-new", "output", 0.5), row("test-sonnet", "input", 3), row("test-sonnet", "output", 15)],
    });
    const { offered, routes } = await readTaskRoutes(env.DB, userId);
    expect(offered.map((m) => m.model)).toEqual(["test-mini"]);
    const why = (task: string) => routes.find((r) => r.task.id === task)!.stopped?.why;
    expect([why("match"), why("score"), why("fill_form"), why("check_form")]).toEqual(["not_listed", "left_out", "no_cap", "unknown"]);
    const html = renderPickerPage({
      viewer: "owner", offered, routes, providerName: () => "OpenRouter", noToolUse: () => false,
      accountSettings: () => ({ label: "Privacy settings", href: "https://example.com/privacy" }),
    });
    const cell = (label: string) => html.match(new RegExp(`<td data-l="Task">${label}</td>[\\s\\S]*?<td data-l="Main">([\\s\\S]*?)</td>`))![1]!;
    const on = (why: string) => `Runs on its fallback for now: ${why} Choose a new main model with Change.`;
    expect(cell("Matching questions")).toBe(on("test-luna is no longer on OpenRouter's list."));
    expect(cell("Scoring roles")).toBe(on(`test-sonnet is left out by your OpenRouter settings. <a href="https://example.com/privacy" target="_blank" rel="noopener noreferrer">Privacy settings</a>`));
    expect(cell("Filling forms")).toBe(on(`openrouter/auto needs a price cap. <a href="/chief-of-staff/models/setup/providers?provider=openrouter&amp;cap=openrouter%2Fauto#m-openrouter-auto">Set its price cap</a>`));
    expect(cell("Checking a form")).toBe(on("test-new is no longer usable."));
    // Each still answers on its fallback.
    expect(await routeTask(env.DB, userId, "fill_form")).toEqual({ main: expect.objectContaining({ model: "test-mini" }) });
  });

  it("gives a task with no saved choice no model, even with one usable model, and says to choose one", async () => {
    await recordTest(userId, "test-luna");
    expect(await routeTask(env.DB, userId, "cover_letter")).toBeUndefined();
    const { offered, routes } = await readTaskRoutes(env.DB, userId);
    const letters = routes.find((r) => r.task.id === "cover_letter")!;
    expect(letters.current).toBeUndefined();
    expect(letters).toMatchObject({ proposal: { main: { model: "test-luna" } }, pending: true });
    const html = renderPickerPage({ viewer: "owner", offered, routes, providerName: () => "OpenRouter", noToolUse: () => false });
    expect(html).toMatch(/<td data-l="Task">Cover letters<\/td>[\s\S]*?<td data-l="Main">test-luna · OpenRouter <span class="pill">proposed<\/span>/);
    expect(html).toContain("Accept all with one tap");
    expect(html).not.toContain("Model now");
    expect(await callTask(env.DB, plugins(), { userId, task: "cover_letter", request: () => ({}) }, () => NOW)).toEqual({
      kind: "no_model",
      task: "cover_letter",
      detail: "no model chosen for this task: choose one for it on Models › Setup › Model for each task (/chief-of-staff/models/setup/tasks)",
    });
    expect(plugin.calls).toEqual([]);
  });

  it("asks for the provider and then the model, offering only usable models", async () => {
    await recordTest(userId, "test-luna");
    await recordTest(userId, "test-mini");
    const { offered, routes } = await readTaskRoutes(env.DB, userId);
    const html = renderPickerPage({ viewer: "owner", offered, routes, providerName: () => "OpenRouter", noToolUse: (m) => m.model === "test-mini" });
    expect(html).toContain('name="main_provider"');
    expect(html).toMatch(/<option value="openrouter"( selected)?>OpenRouter<\/option>/);
    expect(html).toContain('<optgroup label="OpenRouter" data-provider="openrouter">');
    expect(html).toContain("Fallback (another model)");
    expect(html).not.toContain("test-sonnet");
    expect(html).toContain("test-mini · no tool use");
    const response = await handleTaskModels(
      new Request("https://cos.example.com/chief-of-staff/models/setup/tasks/change", {
        method: "POST",
        headers: { origin: "https://cos.example.com" },
        body: new URLSearchParams({ task: "score", main_provider: "openrouter", main_model: "test-mini", fallback_provider: "openrouter", fallback_model: "test-luna" }),
      }),
      { db: env.DB, plugins: plugins(), userId, viewer: "owner", now: NOW },
    );
    expect(response.status).toBe(200);
    expect(await routeTask(env.DB, userId, "score")).toMatchObject({ main: { model: "test-mini" }, fallback: { model: "test-luna" } });
  });
});
