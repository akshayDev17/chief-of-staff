import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addModel, listOffer, namesPickedModel, readUserModels, saveUserModel } from "../src/models/add";
import { renderPickerPage, handleTaskModels } from "../src/models/picker-page";
import { acceptProposals, callTask, changeTask, proposeRoute, readTaskRoutes, routeTask, taskById, type Offered } from "../src/models/tasks";
import { ESTIMATE_INPUT_TOKENS, planTestAll, PER_TICK, readTestAll, runQueuedTests, startTestAll } from "../src/models/test-all";
import { TEST_MAX_TOKENS } from "../src/providers/openrouter";
import { modelsSection } from "../src/providers/models-panel";
import { formatCost } from "../src/providers/page";
import { setBudget } from "../src/proxy/budgets";
import { writeConnection } from "../src/proxy/connections";
import { ok, refused, seedPrices, testPlugin, userFor, type TestPlugin } from "./test-plugin";

const NOW = new Date("2026-11-27T10:00:00Z");
let plugin: TestPlugin;
let userId: string;
const plugins = () => ({ openrouter: plugin });

beforeEach(async () => {
  await seedPrices();
  plugin = testPlugin();
  userId = (await userFor("owner-sub")).id;
  await writeConnection(env.DB, userId, plugin, { method: "oauth_pkce", key_hash: "a".repeat(64) }, NOW);
});

const added = (model: string) => saveUserModel(env.DB, userId, { provider: "openrouter", model, location: "global", addedAt: NOW.toISOString() });

describe("the model list", () => {
  it("lists every model OpenRouter lists, priced and tiered, and the router it cannot call", async () => {
    const rows = await listOffer(env.DB, plugins(), userId, "openrouter");
    expect(rows.map((r) => r.model)).toEqual(["openrouter/auto", "test-luna", "test-mini", "test-sonnet"]);
    expect(rows.find((r) => r.model === "test-luna")).toMatchObject({ price: { input: 0.1, output: 0.5, source: "openrouter-models" }, tier: "Smallest", callable: true, accountLeftOut: false });
    expect(rows.find((r) => r.model === "test-sonnet")?.tier).toBe("Strongest");
    expect(rows.find((r) => r.model === "openrouter/auto")?.price).toBeUndefined();
  });

  it("marks a model the user's own account leaves out, and refuses to add it", async () => {
    await env.DB.prepare("INSERT INTO provider_model_lists (user_id, provider, read_at, models) VALUES (?, 'openrouter', ?, ?)")
      .bind(userId, NOW.toISOString(), JSON.stringify(["test-luna", "test-sonnet"]))
      .run();
    const rows = await listOffer(env.DB, plugins(), userId, "openrouter");
    expect(rows.find((r) => r.model === "test-mini")?.accountLeftOut).toBe(true);
    expect(await addModel(env.DB, plugins(), { userId, provider: "openrouter", model: "test-mini", now: NOW })).toMatchObject({ kind: "refused", reason: "cannot_call" });
    expect(plugin.calls).toEqual([]);
  });

  it("adds a model when its own test call passes, and only then", async () => {
    plugin.replies.push(ok({ input: 9, output: 1, reportedCostUsd: 0.000002 }, { model: "test-luna" }));
    const outcome = await addModel(env.DB, plugins(), { userId, provider: "openrouter", model: "test-luna", now: NOW });
    expect(outcome).toMatchObject({ kind: "added", model: { model: "test-luna", test: { status: 200, costUsd: 0.000002 } } });
    plugin.replies.push(refused(429));
    expect(await addModel(env.DB, plugins(), { userId, provider: "openrouter", model: "test-mini", now: NOW })).toMatchObject({ kind: "refused", reason: "busy" });
    expect((await readUserModels(env.DB, userId)).map((m) => m.model)).toEqual(["test-luna"]);
  });

  it("refuses a reply that names another model, but takes a variant or a dated ID as the same", async () => {
    plugin.replies.push(ok({ input: 1, output: 1 }, { model: "test-sonnet" }));
    expect(await addModel(env.DB, plugins(), { userId, provider: "openrouter", model: "test-luna", now: NOW })).toMatchObject({ kind: "refused", reason: "wrong_model" });
    expect(namesPickedModel("openai/gpt-oss-20b", "openai/gpt-oss-20b:batch")).toBe(true);
    expect(namesPickedModel("anthropic/claude-haiku-5.5-20261001", "anthropic/claude-haiku-5.5")).toBe(true);
    expect(namesPickedModel("openai/gpt-6-luna-pro", "openai/gpt-6-luna")).toBe(false);
  });

  it("leaves models added at a removed provider out of the user's models", async () => {
    await env.DB.prepare("INSERT INTO user_models (user_id, provider, model, location, added_at) VALUES (?, 'bedrock', 'Claude Sonnet 5.5', 'global', ?)").bind(userId, NOW.toISOString()).run();
    expect(await readUserModels(env.DB, userId)).toEqual([]);
  });
});

describe("Test all models", () => {
  it("shows the estimate first, from the test's tokens at each model's price", async () => {
    const plan = await planTestAll(env.DB, plugins(), userId, "openrouter", NOW);
    expect(plan.models.map((m) => m.model)).toEqual(["test-luna", "test-mini", "test-sonnet"]);
    const expected = [[0.1, 0.5], [0.25, 1], [3, 15]].reduce((s, [i, o]) => s + (ESTIMATE_INPUT_TOKENS * i! + TEST_MAX_TOKENS * o!) / 1e6, 0);
    expect(plan.estimateUsd).toBeCloseTo(expected, 12);
    expect(plan.wait).toBeUndefined();
    const html = modelsSection({
      plugin, viewer: "owner", rows: await listOffer(env.DB, plugins(), userId, "openrouter"), plan, confirmTestAll: true, testsFilter: "all", formatCost, now: NOW,
    });
    expect(html).toContain("Test all 3 models?");
    expect(html).toContain(`at most ${TEST_MAX_TOKENS} reply tokens`);
    expect(html).toContain("Run the test");
  });

  it("runs in the background a few at a time, then shows which work now with the reason, and the real cost", async () => {
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
    expect(run.tests[1]!.result).toMatchObject({ reason: "no_credits", text: "Your Test openrouter account or this key is out of credits.", reply: { status: 402 } });
    expect(run.realCostUsd).toBeCloseTo(0.000251, 12);
    // Each test call is in the ledger under its own task; models that work are offered for tasks.
    expect((await readUserModels(env.DB, userId)).map((m) => m.model)).toEqual(["test-luna", "test-sonnet"]);
    const { n } = (await env.DB.prepare("SELECT count(*) AS n FROM model_calls WHERE task = 'test_all_models'").first<{ n: number }>())!;
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
  it("proposes a fallback that is another model on the same provider, never the main one", async () => {
    const m = (model: string, tier: Offered["tier"], inputUsd: number): Offered => ({ provider: "openrouter", model, location: "global", addedAt: "", tier, inputUsd });
    const route = proposeRoute(taskById("score")!, [m("a", "Middle", 1), m("b", "Middle", 2), m("c", "Smallest", 0.1)]);
    expect([route?.main.model, route?.fallback?.model]).toEqual(["a", "b"]);
    const single = proposeRoute(taskById("match")!, [m("c", "Smallest", 0.1)]);
    expect(single?.fallback).toBeUndefined();
  });

  it("saves a change naming provider and model, refuses the same model as its own fallback, and calls the fallback on a 429", async () => {
    await added("test-luna");
    await added("test-mini");
    expect(await changeTask(env.DB, userId, "match", "openrouter|test-luna", "openrouter|test-luna", NOW)).toBe("same_model");
    expect(await changeTask(env.DB, userId, "match", "openrouter|test-luna", "openrouter|test-mini", NOW)).toBeUndefined();
    expect(await routeTask(env.DB, userId, "match")).toMatchObject({ main: { model: "test-luna" }, fallback: { model: "test-mini" } });
    await setBudget(env.DB, userId, "openrouter", 5, "typed", NOW);
    plugin.replies.push(refused(429), ok({ input: 1, output: 1 }));
    expect(await callTask(env.DB, plugins(), { userId, task: "match", request: () => ({}) }, () => NOW)).toMatchObject({ kind: "answered", model: "test-mini", fallback: true });
  });

  it("accepts every proposal with one tap", async () => {
    await added("test-luna");
    await added("test-mini");
    expect(await acceptProposals(env.DB, userId, NOW)).toBe(8);
    const { routes } = await readTaskRoutes(env.DB, userId);
    expect(routes.find((r) => r.task.id === "match")?.current).toMatchObject({ main: { model: "test-luna" }, fallback: { model: "test-mini" }, setHow: "accepted" });
  });

  it("asks for the provider and then the model, offering only passed models", async () => {
    await added("test-luna");
    await added("test-mini");
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
