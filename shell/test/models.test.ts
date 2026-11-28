import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { FREE_NOTE, listOffer, namesPickedModel, testOne, blockKind } from "../src/models/test-model";
import { readLatestTests } from "../src/models/latest-tests";
import { readAccountLive, readReadyModels, readTable, rowState } from "../src/models/ready";
import { parsePriceCap, savePriceCap } from "../src/models/price-caps";
import { renderPickerPage, handleTaskModels, type PickerPageInput } from "../src/models/picker-page";
import { readModelNames, readToReady } from "../src/models/picker-data";
import { acceptProposals, callTask, changeTasks, offeredFor, proposeRoute, readTaskRoutes, routeTask, taskById, TASKS, useFreeModels, type Offered } from "../src/models/tasks";
import { TASK_MODELS_PATH } from "../src/paths";
import { barLabel, modelParts, nextStep, stripCounts, type ModelsTableInput } from "../src/providers/models-table";
import { setBudget } from "../src/proxy/budgets";
import { connectedAt, readHasCredit, writeConnection } from "../src/proxy/connections";
import { writeSnapshot } from "../src/prices/store";
import { HAS_CREDIT, NO_CREDIT, ok, recordTest, refused, row, seedPrices, TEST_CATALOG, testPlugin, userFor, type TestPlugin } from "./test-plugin";

const NOW = new Date("2026-11-27T10:00:00Z");
const ORIGIN = "https://cos.example.com";
// The current key: made before every call these record (recordTest's 09:00 among them).
const CONNECTED = new Date("2026-11-27T08:00:00Z");
let plugin: TestPlugin;
let userId: string;
const plugins = () => ({ openrouter: plugin });
const CREDITS = { label: "Add credits", href: "https://openrouter.ai/settings/credits" };
const SETTINGS = { label: "Privacy settings", href: "https://example.com/privacy" };
// The plug-in itself, its guide given the provider's credits and settings pages.
const withLinks = (p: TestPlugin): TestPlugin => {
  p.connect.guide = { ...p.connect.guide, credits: CREDITS, accountSettings: SETTINGS };
  return p;
};

beforeEach(async () => {
  await seedPrices();
  plugin = testPlugin("openrouter", { routers: ["openrouter/auto"] });
  userId = (await userFor("owner-sub")).id;
  await writeConnection(env.DB, userId, plugin, { method: "oauth_pkce", key_hash: "a".repeat(64) }, CONNECTED);
});

const ready = async () => (await readReadyModels(env.DB, plugins(), userId)).map((m) => m.model);
const stateOf = async (model: string) => (await readTable(env.DB, plugins(), userId, "openrouter")).rows.find((r) => r.model === model)?.state;
const accountList = (models: string[]) =>
  env.DB.prepare("INSERT INTO provider_model_lists (user_id, provider, read_at, models) VALUES (?, 'openrouter', ?, ?) ON CONFLICT (user_id, provider) DO UPDATE SET models = excluded.models")
    .bind(userId, NOW.toISOString(), JSON.stringify(models))
    .run();
const latestCount = async () => (await env.DB.prepare("SELECT count(*) AS n FROM model_latest_tests").first<{ n: number }>())!.n;

// A free model beside the seeded paid ones.
const withFree = () =>
  writeSnapshot(env.DB, {
    takenAt: "2026-11-27T07:00:00Z", status: "good", results: [],
    catalog: { ...TEST_CATALOG, models: [...TEST_CATALOG.models, { id: "test-free:free", name: "Test Free", tools: true, free: true as const }] },
    rows: [row("test-luna", "input", 0.1), row("test-luna", "output", 0.5), row("test-mini", "input", 0.25), row("test-mini", "output", 1), row("test-sonnet", "input", 3), row("test-sonnet", "output", 15), row("test-free:free", "input", 0), row("test-free:free", "output", 0)],
  });

describe("the model list", () => {
  it("lists every model OpenRouter lists with tool use, priced and tiered, and the router without a price until it has a cap", async () => {
    plugin = testPlugin("openrouter", { routers: ["openrouter/auto"], noToolUse: ["test-mini"] });
    const rows = await listOffer(env.DB, plugins(), userId, "openrouter");
    // test-mini lists no tool use: it never reaches the list.
    expect(rows.map((r) => r.model)).toEqual(["openrouter/auto", "test-luna", "test-sonnet"]);
    expect(rows.find((r) => r.model === "test-luna")).toMatchObject({ price: { input: 0.1, output: 0.5, source: "openrouter-models" }, tier: "Smallest", callable: true, accountLeftOut: false });
    expect(rows.find((r) => r.model === "test-sonnet")?.tier).toBe("Strongest");
    const auto = rows.find((r) => r.model === "openrouter/auto")!;
    expect(auto).toMatchObject({ router: true });
    expect(auto.price).toBeUndefined();
    expect(blockKind(auto)).toBe("router");
    // Nor can it be tested.
    expect(await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-mini", now: NOW })).toMatchObject({ kind: "refused", reason: "not_offered" });
  });

  it("marks a model the user's own account leaves out, and tests it with no call", async () => {
    await accountList(["test-luna", "test-sonnet"]);
    const rows = await listOffer(env.DB, plugins(), userId, "openrouter");
    expect(rows.find((r) => r.model === "test-mini")?.accountLeftOut).toBe(true);
    expect(await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-mini", now: NOW })).toMatchObject({ kind: "refused", reason: "cannot_call" });
    expect(plugin.calls).toEqual([]);
    expect((await readLatestTests(env.DB, userId, "openrouter")).size).toBe(0);
  });

  it("keeps an older call from replacing a newer one", async () => {
    await recordTest(userId, "test-luna", "failed", "2026-11-27T10:00:00.000Z");
    await recordTest(userId, "test-luna", "passed", "2026-11-27T09:00:00.000Z");
    expect((await readLatestTests(env.DB, userId, "openrouter")).get("test-luna")?.state).toBe("failed");
  });

  it("fails a reply that names another model, but takes a variant or a dated ID as the same", async () => {
    plugin.replies.push(ok({ input: 1, output: 1 }, { model: "test-sonnet" }));
    expect(await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-luna", now: NOW })).toMatchObject({ kind: "refused", reason: "wrong_model" });
    expect(await stateOf("test-luna")).toBe("failed");
    expect(namesPickedModel("openai/gpt-oss-20b", "openai/gpt-oss-20b:batch")).toBe(true);
    expect(namesPickedModel("anthropic/claude-haiku-5.5-20261001", "anthropic/claude-haiku-5.5")).toBe(true);
    expect(namesPickedModel("openai/gpt-6-luna-pro", "openai/gpt-6-luna")).toBe(false);
  });
});

describe("Ready, with no test call", () => {
  it("makes every model the provider offers Ready with no call at all, when nothing blocks it and the account has credit", async () => {
    expect(await ready()).toEqual(["test-luna", "test-mini", "test-sonnet"]);
    expect(plugin.calls).toEqual([]);
    expect(await latestCount()).toBe(0);
    // The router has no cap yet: it needs a step.
    expect(await stateOf("openrouter/auto")).toBe("step");
  });

  it("reads a paid model on a $0 account as Needs credit and a free one as Ready, and credit added flips the paid ones on the next read, with no click", async () => {
    await withFree();
    plugin = testPlugin("openrouter", { routers: ["openrouter/auto"], account: NO_CREDIT });
    // Before the account line is read on this key, paid models wait for it.
    expect(await readHasCredit(env.DB, userId, "openrouter")).toBeUndefined();
    expect(await ready()).toEqual(["test-free:free"]);
    // A visit reads it live: still no credit.
    await readAccountLive(env.DB, plugin, userId);
    expect(await readHasCredit(env.DB, userId, "openrouter")).toBe(false);
    expect([await stateOf("test-luna"), await stateOf("test-sonnet"), await stateOf("test-free:free")]).toEqual(["credit", "credit", "ready"]);
    // Credit is added on OpenRouter; the next visit's read makes them Ready.
    plugin.account = HAS_CREDIT;
    await readAccountLive(env.DB, plugin, userId);
    expect(await ready()).toEqual(["test-free:free", "test-luna", "test-mini", "test-sonnet"]);
    expect(plugin.calls).toEqual([]);
    // A key whose own limit is used up has no credit left.
    plugin.account = { freeTier: false, usageUsd: 5, limitUsd: 5, limitRemainingUsd: 0 };
    await readAccountLive(env.DB, plugin, userId);
    expect(await ready()).toEqual(["test-free:free"]);
    // A read that fails keeps the last figure.
    plugin.account = undefined;
    await readAccountLive(env.DB, plugin, userId);
    expect(await readHasCredit(env.DB, userId, "openrouter")).toBe(false);
  });

  it("puts a model the account's settings leave out, a router with no cap and a model with no price in Needs a step, never Ready", async () => {
    await accountList(["openrouter/auto", "test-luna", "test-sonnet"]);
    expect(await stateOf("test-mini")).toBe("step");
    expect(await stateOf("openrouter/auto")).toBe("step");
    expect(await ready()).toEqual(["test-luna", "test-sonnet"]);
    // A capped router is Ready.
    await savePriceCap(env.DB, userId, "openrouter", "openrouter/auto", { input: 1, output: 2 }, NOW);
    expect(await ready()).toEqual(["openrouter/auto", "test-luna", "test-sonnet"]);
    const offer = (await listOffer(env.DB, plugins(), userId, "openrouter")).find((r) => r.model === "test-luna")!;
    expect(rowState({ ...offer, price: undefined }, undefined, true)).toBe("step");
  });

  it("marks a model whose latest call on this key failed as Failed until a later call works, and ignores one on an earlier key", async () => {
    await recordTest(userId, "test-luna", "failed", "2026-11-27T09:00:00.000Z", true);
    expect(await stateOf("test-luna")).toBe("failed");
    expect(await ready()).toEqual(["test-mini", "test-sonnet"]);
    await recordTest(userId, "test-luna", "passed", "2026-11-27T09:30:00.000Z");
    expect(await stateOf("test-luna")).toBe("ready");
    // A failure made before the current key marks nothing.
    await recordTest(userId, "test-mini", "failed", "2026-11-27T07:00:00.000Z");
    expect(await stateOf("test-mini")).toBe("ready");
  });

  it("marks a model Failed when its Test gets a verdict, and leaves it Ready after a refusal that says nothing about it", async () => {
    plugin.replies.push(ok({ input: 9, output: 1, reportedCostUsd: 0.02 }, { model: "test-luna" }));
    expect(await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-luna", now: NOW })).toMatchObject({ kind: "passed", test: { status: 200, costUsd: 0.02 } });
    const passed = (await readLatestTests(env.DB, userId, "openrouter")).get("test-luna");
    const at = (minute: number) => new Date(`2026-11-27T10:${String(minute).padStart(2, "0")}:00Z`);
    for (const [status, reason] of [[429, "busy"], [402, "no_credits"], [401, "not_set_up"]] as const) {
      plugin.replies.push(refused(status));
      expect(await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-luna", now: at(status % 50) })).toMatchObject({ kind: "refused", reason, notVerdict: true, reply: { status } });
      expect((await readLatestTests(env.DB, userId, "openrouter")).get("test-luna")).toEqual(passed);
      expect(await stateOf("test-luna")).toBe("ready");
    }
    // The month's budget is spent by the first test's $0.02.
    await setBudget(env.DB, userId, "openrouter", 0.01, "typed", NOW);
    expect(await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-luna", now: at(21) })).toMatchObject({ kind: "refused", reason: "budget_spent", notVerdict: true });
    expect(await stateOf("test-luna")).toBe("ready");
    await setBudget(env.DB, userId, "openrouter", 10, "typed", NOW);
    plugin.replies.push(refused(400));
    expect(await testOne(env.DB, plugins(), { userId, provider: "openrouter", model: "test-luna", now: at(30) })).toMatchObject({ kind: "refused", reason: "refused" });
    expect((await readLatestTests(env.DB, userId, "openrouter")).get("test-luna")).toMatchObject({ state: "failed", result: { reason: "refused", reply: { status: 400 } } });
    expect(await stateOf("test-luna")).toBe("failed");
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
    expect(await ready()).toContain("openrouter/auto");
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
  const p = extra.plugin ?? plugin;
  const { rows } = await readTable(env.DB, { openrouter: p }, userId, "openrouter");
  return { plugin: p, viewer: "owner", rows, usedBy: new Map(), view: {}, now: NOW, catalog: { readAt: TEST_CATALOG.readAt, current: true, noToolUse: 0 }, ...extra };
};
const cellOf = (strip: string, k: string) => Number(strip.match(new RegExp(`data-filter="${k}"[\\s\\S]*?<span class="v num[^"]*">(\\d+)</span>`))![1]);
const rowHtml = (rows: string, model: string) => rows.split("\n").find((l) => l.includes(`data-id="${model}"`))!;

describe("the Providers table", () => {
  it("puts every row in exactly one strip cell, so the cells add up to the list's own count", async () => {
    await accountList(["openrouter/auto", "test-luna", "test-sonnet"]);
    await recordTest(userId, "test-sonnet", "failed", "2026-11-27T09:00:00.000Z", true);
    const input = await tableInput();
    const { strip, rows } = modelParts(input);
    const c = stripCounts(input.rows);
    expect(c).toEqual({ ready: 1, credit: 0, failed: 1, step: 2, total: 4 });
    expect(c.ready + c.credit + c.failed + c.step).toBe(input.rows.length);
    expect([cellOf(strip, "ready"), cellOf(strip, "credit"), cellOf(strip, "failed"), cellOf(strip, "step")]).toEqual([1, 0, 1, 2]);
    expect(strip).toContain("<span data-ends>4 models</span>");
    expect(rows.split("\n")).toHaveLength(4);
    expect(barLabel(c)).toBe("1 of 4 ready: 0 need credit, 1 failed when used, 2 need a step");
  });

  it("labels the strip Ready, never Works, and offers no Test all or Retest", async () => {
    const parts = modelParts(await tableInput());
    const html = Object.values(parts).join("");
    expect(parts.strip).toContain('<span class="l">Ready</span>');
    for (const gone of ["Works", "Test all", "Retest", "Not tested yet", "Doesn't work", "earlier key"]) expect(html).not.toContain(gone);
    expect(parts).not.toHaveProperty("rail");
  });

  it("shows Failed when used with its plain reason and Try again on a row a task's call failed, and Failed when tested for a Test", async () => {
    await recordTest(userId, "test-luna", "failed", "2026-11-27T09:00:00.000Z", true);
    await recordTest(userId, "test-mini", "failed", "2026-11-27T09:00:00.000Z");
    const { rows } = modelParts(await tableInput());
    const luna = rowHtml(rows, "test-luna");
    expect(luna).toContain('data-state="failed"');
    expect(luna).toContain('<span class="meta why"><span class="fw">Failed when used</span> · No such model. · <button type="button" class="link" data-det="m-test-luna"');
    expect(luna).toMatch(/<button type="submit" class="btn tbtn again" data-k="t-test-luna" data-busy="Trying…"[^>]*aria-label="Try again Test Luna"[^>]*><span class="ico">.*?<\/span><span class="lbl">Try again<\/span><\/button>/);
    expect(rowHtml(rows, "test-mini")).toContain('<span class="fw">Failed when tested</span> · No such model.');
    // A Ready row keeps plain Test.
    expect(rowHtml(rows, "test-sonnet")).toContain('<span class="lbl">Test</span>');
  });

  it("names the tasks that fall to their fallback under a Try again that failed", async () => {
    await recordTest(userId, "test-luna", "failed", "2026-11-27T09:00:00.000Z", true);
    const { rows } = modelParts(await tableInput({ view: { results: [{ model: "test-luna" }] }, usedBy: new Map([["test-luna", [{ task: "Matching questions", fallback: "Test Mini" }, { task: "Extracting facts" }]]]) }));
    const luna = rowHtml(rows, "test-luna");
    expect(luna).toContain("<strong>Failed when used · No such model.</strong>");
    expect(luna).toContain("<p>Matching questions falls to Test Mini when it fails.</p><p>Extracting facts has no fallback.</p>");
  });

  it("reads Needs credit on a $0 account's paid rows, with Add credits in its cell", async () => {
    plugin = withLinks(testPlugin("openrouter", { routers: ["openrouter/auto"], account: NO_CREDIT }));
    await readAccountLive(env.DB, plugin, userId);
    const { strip, rows } = modelParts(await tableInput());
    expect(cellOf(strip, "credit")).toBe(3);
    expect(strip).toContain('<a class="cell-act ext" href="https://openrouter.ai/settings/credits" target="_blank" rel="noopener noreferrer" data-credit-act>Add credits</a>');
    expect(rowHtml(rows, "test-luna")).toContain('<span class="pill warn">Needs credit</span>');
    // With credit, the cell is empty and its link hidden.
    plugin.account = HAS_CREDIT;
    await readAccountLive(env.DB, plugin, userId);
    const after = modelParts(await tableInput()).strip;
    expect(cellOf(after, "credit")).toBe(0);
    expect(after).toContain("data-credit-act hidden>Add credits</a>");
  });

  it("drops the earlier key's note: a call on an earlier key shows on no row", async () => {
    await recordTest(userId, "test-luna", "passed", "2026-11-27T07:00:00.000Z");
    await recordTest(userId, "test-mini", "failed", "2026-11-27T07:00:00.000Z");
    const { rows } = modelParts(await tableInput());
    expect(rows).not.toContain("earlier key");
    expect(rowHtml(rows, "test-mini")).toContain('data-state="ready"');
  });

  it("makes Refresh model list the next step while the list is stale, else Next", () => {
    expect(nextStep({ connected: false, view: {}, catalogCurrent: true })).toBe("connect");
    expect(nextStep({ connected: true, view: { cap: "openrouter/auto" }, catalogCurrent: true })).toBe("cap");
    expect(nextStep({ connected: true, view: {}, catalogCurrent: false })).toBe("refresh");
    expect(nextStep({ connected: true, view: {}, catalogCurrent: true })).toBe("next");
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
  const page = async (extra: Partial<PickerPageInput> = {}) => {
    const { offered, routes } = await readTaskRoutes(env.DB, plugins(), userId);
    return renderPickerPage({ viewer: "owner", offered, routes, providerName: () => "OpenRouter", noToolUse: () => false, nameOf: await readModelNames(env.DB), ...extra });
  };
  // A task's row, and the values its plain select offers for `role`.
  const rowOf = (html: string, task: string) => html.match(new RegExp(`<li class="task" id="task-${task}"[\\s\\S]*?</form></li>`))![0];
  const optionsOf = (html: string, role: string, task: string) =>
    [...html.match(new RegExp(`<select class="nsel" id="${role}-${task}"[^>]*>([\\s\\S]*?)</select>`))![1]!.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
  const listOf = (html: string, role: string, task: string) =>
    [...html.match(new RegExp(`<ul role="listbox" id="pl-${role}-${task}"[^>]*>([\\s\\S]*?)</ul>`))![1]!.matchAll(/data-value="([^"]*)"/g)].map((m) => m[1]);
  const or = (m: string) => `openrouter|${m}`;
  const m = (model: string, tier: Offered["tier"], inputUsd: number, free = false): Offered => ({ provider: "openrouter", model, location: "global", state: "ready", tier, inputUsd, free });

  it("offers each task every Ready model whose strength chip is its own, the cheapest first, with no test", async () => {
    await tieredPrices();
    // test-mini's latest call failed: not Ready, so offered nowhere.
    await recordTest(userId, "test-mini", "failed", "2026-11-27T09:00:00.000Z", true);
    const { offered } = await readTaskRoutes(env.DB, plugins(), userId);
    expect(offered.find((x) => x.model === "test-fee")).toMatchObject({ otherFees: true });
    expect(offered.find((x) => x.model === "test-fee")).not.toHaveProperty("tier");
    expect(offered.find((x) => x.model === "test-free:free")).toMatchObject({ tier: "Smallest", free: true, inputUsd: 0, outputUsd: 0, name: "Test Free", state: "ready" });
    expect(offeredFor(taskById("match")!, offered).map((x) => x.model)).toEqual(["test-free:free", "test-luna"]);
    expect(offeredFor(taskById("score")!, offered).map((x) => x.model)).toEqual(["test-mid", "test-mid2"]);
    expect(plugin.calls).toEqual([]);
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

  it("lists the paid models once credit is added, on the next visit, with no click", async () => {
    await tieredPrices();
    plugin = testPlugin("openrouter", { routers: ["openrouter/auto"], account: NO_CREDIT });
    const visit = async () =>
      (await handleTaskModels(new Request(`${ORIGIN}${TASK_MODELS_PATH}`), { db: env.DB, plugins: plugins(), userId, viewer: "owner", now: NOW })).text();
    const before = await visit();
    expect(listOf(before, "main", "match")).toEqual([or("test-free:free")]);
    expect(rowOf(before, "score")).toContain("No Middle model is ready yet. Paid ones need credit.");
    plugin.account = HAS_CREDIT;
    const after = await visit();
    expect(listOf(after, "main", "match")).toEqual([or("test-free:free"), or("test-luna"), or("test-mini")]);
    expect(listOf(after, "main", "score")).toEqual([or("test-mid"), or("test-mid2")]);
    expect(plugin.calls).toEqual([]);
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
    // A model that is not Ready is never proposed.
    expect(proposeRoute(taskById("score")!, [{ ...m("a", "Middle", 1), state: "credit" }, m("b", "Middle", 2)])).toMatchObject({ main: { model: "b" } });
  });

  it("never proposes a free model, and saves one the user chooses for a task of its strength only", async () => {
    await tieredPrices();
    await accountList(["test-free:free"]);
    expect(await routeTask(env.DB, plugins(), userId, "match")).toBeUndefined();
    const first = (await readTaskRoutes(env.DB, plugins(), userId)).routes[0]!;
    expect([first.current, first.proposal, first.pending]).toEqual([undefined, undefined, false]);
    expect(await changeTasks(env.DB, plugins(), userId, [{ task: "score", main: or("test-free:free"), fallback: "" }], NOW)).toEqual({ task: "score", problem: "wrong_strength" });
    expect(await changeTasks(env.DB, plugins(), userId, [{ task: "match", main: or("test-free:free"), fallback: "" }], NOW)).toBeUndefined();
    expect(await routeTask(env.DB, plugins(), userId, "match")).toMatchObject({ main: { model: "test-free:free" } });
  });

  it("saves changes all or none, refuses a model of another strength, one not Ready or the main as its own fallback, and calls the fallback on a 429", async () => {
    await tieredPrices();
    await recordTest(userId, "test-mid2", "failed", "2026-11-27T09:00:00.000Z", true);
    const change = (task: string, main: string, fallback = "") => ({ task, main: main && or(main), fallback: fallback && or(fallback) });
    const save = (...changes: Array<ReturnType<typeof change>>) => changeTasks(env.DB, plugins(), userId, changes, NOW);
    expect(await save(change("match", "test-luna", "test-luna"))).toEqual({ task: "match", problem: "same_model" });
    expect(await save(change("score", "test-mid2"))).toEqual({ task: "score", problem: "not_your_model" });
    expect(await save(change("score", "test-sonnet"))).toEqual({ task: "score", problem: "wrong_strength" });
    expect(await save(change("score", "test-mid", "test-luna"))).toEqual({ task: "score", problem: "wrong_strength" });
    expect(await save(change("match", ""))).toEqual({ task: "match", problem: "no_main" });
    expect(await save(change("nope", "test-luna"))).toEqual({ task: "nope", problem: "no_such_task" });
    // One refused change saves none of them.
    expect(await save(change("extract", "test-luna"), change("score", "test-sonnet"))).toEqual({ task: "score", problem: "wrong_strength" });
    expect(await routeTask(env.DB, plugins(), userId, "extract")).toBeUndefined();
    expect(await save(change("match", "test-luna", "test-mini"), change("score", "test-mid"))).toBeUndefined();
    expect(await routeTask(env.DB, plugins(), userId, "match")).toMatchObject({ main: { model: "test-luna" }, fallback: { model: "test-mini" } });
    expect(await routeTask(env.DB, plugins(), userId, "score")).toMatchObject({ main: { model: "test-mid" } });
    await setBudget(env.DB, userId, "openrouter", 5, "typed", NOW);
    plugin.replies.push(refused(429), ok({ input: 1, output: 1 }));
    expect(await callTask(env.DB, plugins(), { userId, task: "match", request: () => ({}) }, () => NOW)).toMatchObject({ kind: "answered", model: "test-mini", fallback: true });
  });

  it("keeps a saved choice of another strength running and shows it as it is, and lets one role change without the other", async () => {
    await tieredPrices();
    await env.DB.prepare("INSERT INTO task_routes (user_id, task, main_provider, main_model, fallback_provider, fallback_model, set_how, set_at) VALUES (?, 'score', 'openrouter', 'test-sonnet', NULL, NULL, 'changed', ?)").bind(userId, NOW.toISOString()).run();
    expect(await routeTask(env.DB, plugins(), userId, "score")).toMatchObject({ main: { model: "test-sonnet" } });
    const html = await page();
    const score = rowOf(html, "score");
    expect(score).toContain('<span class="ov-nm">Test Sonnet</span><span class="ov-pr num">$3.00 / $15.00</span></span><span class="ov-l2"><span class="ov-id">test-sonnet</span><span class="pill">Strongest</span>');
    expect(score).toContain('<span data-about="main">Its main model is a Strongest model, kept from before.</span>');
    // Its plain select keeps it, the list offers only Middle models.
    expect(optionsOf(html, "main", "score")).toEqual([or("test-sonnet"), or("test-mid"), or("test-mid2")]);
    expect(listOf(html, "main", "score")).toEqual([or("test-mid"), or("test-mid2")]);
    // A fallback added beside the kept main model saves; the kept model may not be chosen for another task.
    expect(await changeTasks(env.DB, plugins(), userId, [{ task: "score", main: or("test-sonnet"), fallback: or("test-mid") }], NOW)).toBeUndefined();
    expect(await routeTask(env.DB, plugins(), userId, "score")).toMatchObject({ main: { model: "test-sonnet" }, fallback: { model: "test-mid" } });
    expect(await changeTasks(env.DB, plugins(), userId, [{ task: "fill_form", main: or("test-sonnet"), fallback: "" }], NOW)).toEqual({ task: "fill_form", problem: "wrong_strength" });
  });

  it("accepts every proposal with one tap, only where the task's own strength has models", async () => {
    const smallest = TASKS.filter((t) => t.tier === "Smallest").length;
    expect(await acceptProposals(env.DB, plugins(), userId, NOW)).toBe(smallest);
    const { routes } = await readTaskRoutes(env.DB, plugins(), userId);
    expect(routes.find((r) => r.task.id === "match")?.current).toMatchObject({ main: { model: "test-luna" }, fallback: { model: "test-mini" }, setHow: "accepted" });
    expect(routes.find((r) => r.task.id === "score")).toMatchObject({ proposal: undefined, pending: false });
    expect(routes.find((r) => r.task.id === "score")!.current).toBeUndefined();
  });

  it("says why a saved model is no longer offered, by the same checks that decide it, with the action that fixes it", async () => {
    plugin = testPlugin("openrouter", { routers: ["openrouter/auto"], noToolUse: ["test-tl"] });
    const route = (task: string, main: string, fallback = "test-mini") =>
      env.DB.prepare("INSERT INTO task_routes (user_id, task, main_provider, main_model, fallback_provider, fallback_model, set_how, set_at) VALUES (?, ?, 'openrouter', ?, 'openrouter', ?, 'changed', ?)").bind(userId, task, main, fallback, NOW.toISOString());
    await env.DB.batch([
      route("match", "test-luna"),
      route("extract", "test-sonnet"),
      route("linkedin_message", "openrouter/auto"),
      route("score", "test-noprice"),
      route("fill_form", "test-tl"),
      env.DB.prepare("INSERT INTO provider_model_lists (user_id, provider, read_at, models) VALUES (?, 'openrouter', ?, ?)")
        .bind(userId, NOW.toISOString(), JSON.stringify(["openrouter/auto", "test-mini", "test-noprice", "test-tl"])),
    ]);
    // OpenRouter stops listing test-luna; it lists test-noprice with no price yet, and test-tl with no tool use.
    await writeSnapshot(env.DB, {
      takenAt: "2026-11-27T11:00:00Z", status: "good", results: [],
      catalog: { ...TEST_CATALOG, models: [...TEST_CATALOG.models.filter((x) => x.id !== "test-luna"), { id: "test-noprice", name: "Test No Price", tools: true }, { id: "test-tl", name: "Test Toolless", tools: false }] },
      rows: [row("test-mini", "input", 0.25), row("test-mini", "output", 1), row("test-sonnet", "input", 3), row("test-sonnet", "output", 15), row("test-tl", "input", 0.1), row("test-tl", "output", 0.1)],
    });
    const { routes } = await readTaskRoutes(env.DB, plugins(), userId);
    const why = (task: string) => routes.find((r) => r.task.id === task)!.stopped?.why;
    expect([why("match"), why("extract"), why("linkedin_message"), why("score"), why("fill_form")]).toEqual(["not_listed", "left_out", "no_cap", "unknown", "no_tools"]);
    const html = await page({ accountSettings: () => SETTINGS });
    const says = (task: string) => rowOf(html, task).match(/<div class="t-note">([\s\S]*?)<button type="submit"/)![1]!;
    const on = (text: string, fix: string) => `<p class="t-says"><span data-about="main">${text} Runs on its fallback for now.</span></p><span class="t-act" data-about="main">${fix}</span>`;
    expect(says("match")).toBe(on("test-luna is no longer on OpenRouter&#39;s list.", `<a class="btn small" href="#main-match" data-open="main-match">Choose another</a>`));
    expect(says("extract")).toBe(on("Test Sonnet is left out by your OpenRouter settings.", `<a class="btn small ext" href="https://example.com/privacy" target="_blank" rel="noopener noreferrer">Privacy settings</a>`));
    expect(says("linkedin_message")).toBe(on("Auto router needs a price cap.", `<a class="btn small" href="/chief-of-staff/models/setup/providers?provider=openrouter&amp;cap=openrouter%2Fauto#m-openrouter-auto">Set its price cap</a>`));
    expect(says("score")).toContain("Test No Price is no longer offered.");
    expect(says("fill_form")).toContain("Test Toolless lists no tool use.");
    expect(rowOf(html, "match")).toContain('<span class="pill bad">Not offered</span>');
    // Each still answers on its fallback.
    expect(await routeTask(env.DB, plugins(), userId, "linkedin_message")).toEqual({ main: expect.objectContaining({ model: "test-mini" }) });
  });

  it("shows a saved fallback the provider no longer offers, with why and its fix, while the main model runs alone", async () => {
    await changeTasks(env.DB, plugins(), userId, [{ task: "match", main: or("test-luna"), fallback: or("test-mini") }], NOW);
    await accountList(["test-luna", "test-sonnet"]);
    const { routes } = await readTaskRoutes(env.DB, plugins(), userId);
    expect(routes[0]).toMatchObject({ current: { main: { model: "test-luna" }, fallback: undefined }, fallbackGone: { model: "test-mini", why: "left_out" } });
    expect(await routeTask(env.DB, plugins(), userId, "match")).toEqual({ main: expect.objectContaining({ model: "test-luna" }) });
    const html = await page({ accountSettings: () => SETTINGS });
    expect(rowOf(html, "match")).toContain('<span class="ov-id">test-mini</span><span class="pill bad">Not offered</span>');
    expect(rowOf(html, "match")).toContain('<span data-about="fallback">Its fallback Test Mini is left out by your OpenRouter settings.</span></p><span class="t-act" data-about="fallback"><a class="btn small ext" href="https://example.com/privacy"');
  });

  it("says in a strength's rows when it has no Ready model, with Add credits where its paid models need credit", async () => {
    await tieredPrices();
    plugin = withLinks(testPlugin("openrouter", { routers: ["openrouter/auto"], account: NO_CREDIT }));
    await readAccountLive(env.DB, plugin, userId);
    const toReady = (await readToReady(env.DB, plugins(), userId))!;
    // Counted by the strength chips of the rows the strip counts as Needs credit.
    expect(toReady).toEqual({ provider: "openrouter", connected: true, needCredit: { Smallest: 2, Middle: 2, Strongest: 1 }, credits: CREDITS });
    const html = await page({ toReady });
    const add = `<a class="btn small ext" href="https://openrouter.ai/settings/credits" target="_blank" rel="noopener noreferrer">Add credits</a>`;
    expect(rowOf(html, "score")).toContain(`<p class="t-says"><span>No Middle model is ready yet. Paid ones need credit.</span></p><span class="t-act">${add}</span>`);
    expect(rowOf(html, "score")).toContain('<button type="button" class="pick-btn" id="pb-main-score" aria-haspopup="listbox" aria-expanded="false" aria-controls="pl-main-score" aria-labelledby="lbl-main-score pb-main-score" disabled>');
    // The free tap comes first; once it is taken, the first such row's link is the one solid button.
    expect(html).toContain("Use my free models for 3 tasks</button>");
    await useFreeModels(env.DB, plugins(), userId, NOW);
    const after = await page({ toReady });
    expect(rowOf(after, "score")).toContain(add.replace('class="btn small ext"', 'class="btn small primary ext"'));
    expect(rowOf(after, "fill_form")).toContain(add);
    // No paid model to add credit for: the link shows the strength's models; not connected: Connect.
    expect(await page({ toReady: { ...toReady, needCredit: {} } })).toContain('href="/chief-of-staff/models/setup/providers?provider=openrouter&amp;strength=Middle#test">See Middle models</a>');
    expect(await page({ toReady: { ...toReady, connected: false } })).toContain('href="/chief-of-staff/models/setup/providers">Connect OpenRouter</a>');
  });

  it("gives a task with no saved choice no model, even with Ready models, and says to choose one", async () => {
    expect(await routeTask(env.DB, plugins(), userId, "extract")).toBeUndefined();
    const { routes } = await readTaskRoutes(env.DB, plugins(), userId);
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
    expect(await routeTask(env.DB, plugins(), userId, "match")).toMatchObject({ main: { model: "test-mini" }, fallback: { model: "test-luna" } });
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
    // Ask Admin for help saves no row sent with it, and answers in place with what it says only.
    const help = await handleTaskModels(
      new Request(`${ORIGIN}${TASK_MODELS_PATH}/help`, { method: "POST", headers: { origin: ORIGIN, accept: "application/json" }, body: new URLSearchParams([["task", "score"], ["main.score", or("test-mini")], ["fallback.score", ""]]) }),
      { db: env.DB, plugins: plugins(), userId, viewer: "friend", now: NOW },
    );
    expect([help.status, await help.json()]).toEqual([200, { said: "Sent to Admin: this item's name and its reason only." }]);
    expect((await saved()).map((r) => r.task)).toEqual(["extract", "linkedin_message", "match"]);
  });
});

// The owner, 2026-11-28: when a task's real call fails, it falls to the
// task's fallback model and the failed model's row shows "Failed when used ·
// <reason> · Try again".
describe("a task's own call that fails", () => {
  const call = (at: Date) => callTask(env.DB, plugins(), { userId, task: "match", request: () => ({}) }, () => at);
  const noEndpoints = () => ({ status: 404, body: { error: { code: 404, message: "No endpoints found matching your data policy" } }, error: { name: "HTTP 404", message: "No endpoints found matching your data policy" } });

  beforeEach(async () => {
    await changeTasks(env.DB, plugins(), userId, [{ task: "match", main: "openrouter|test-luna", fallback: "openrouter|test-mini" }], NOW);
    await setBudget(env.DB, userId, "openrouter", 5, "typed", NOW);
  });

  it("falls to the fallback, marks the main model Failed when used with its plain reason, and takes that back once a call of it answers", async () => {
    plugin.replies.push(noEndpoints(), ok({ input: 1, output: 1 }));
    expect(await call(NOW)).toMatchObject({ kind: "answered", model: "test-mini", fallback: true });
    expect(plugin.calls.map((c) => c.model)).toEqual(["test-luna", "test-mini"]);
    const latest = (await readLatestTests(env.DB, userId, "openrouter")).get("test-luna")!;
    expect(latest).toMatchObject({ state: "failed", result: { reason: "refused", used: true, reply: { status: 404, message: "No endpoints found matching your data policy" } } });
    expect(await stateOf("test-luna")).toBe("failed");
    // The Providers row says so, with Try again.
    const { rows } = modelParts(await tableInput());
    expect(rowHtml(rows, "test-luna")).toContain('<span class="fw">Failed when used</span> · openrouter refused the call.');
    expect(rowHtml(rows, "test-luna")).toContain('<span class="lbl">Try again</span>');
    // The dropdowns leave it out, while the task keeps it and tries it first.
    const { offered, routes } = await readTaskRoutes(env.DB, plugins(), userId);
    expect(offeredFor(taskById("match")!, offered).map((x) => x.model)).toEqual(["test-mini"]);
    expect(routes[0]!.current).toMatchObject({ main: { model: "test-luna", state: "failed" }, fallback: { model: "test-mini" } });
    const html = renderPickerPage({ viewer: "owner", offered, routes, providerName: () => "OpenRouter", noToolUse: () => false });
    expect(html).toContain('<span class="pill bad">Failed when used</span>');
    expect(html).toContain("Its main model failed when used. Calls fall to its fallback meanwhile.");
    // The next call tries it first; it answers, and the mark is gone.
    plugin.replies.push(ok({ input: 1, output: 1 }));
    expect(await call(new Date("2026-11-27T10:05:00Z"))).toMatchObject({ kind: "answered", model: "test-luna", fallback: false });
    expect(await stateOf("test-luna")).toBe("ready");
  });

  it("marks a paid main model that was refused for credit, and a fallback that failed too", async () => {
    plugin.replies.push(refused(402), refused(400));
    expect(await call(NOW)).toMatchObject({ kind: "provider_error", model: "test-mini", fallback: true, status: 400 });
    expect((await readLatestTests(env.DB, userId, "openrouter")).get("test-luna")?.result).toMatchObject({ reason: "no_credits", used: true });
    expect([await stateOf("test-luna"), await stateOf("test-mini")]).toEqual(["failed", "failed"]);
  });

  it("marks nothing for a busy or unanswered call, and falls to the fallback all the same", async () => {
    plugin.replies.push(refused(429), ok({ input: 1, output: 1 }));
    expect(await call(NOW)).toMatchObject({ kind: "answered", model: "test-mini", fallback: true });
    plugin.replies.push(new Error("network"), ok({ input: 1, output: 1 }));
    expect(await call(NOW)).toMatchObject({ kind: "answered", model: "test-mini", fallback: true });
    expect(await latestCount()).toBe(0);
    expect(await stateOf("test-luna")).toBe("ready");
  });

  it("never falls back on a key removed on the provider's side: the fallback shares it", async () => {
    plugin.replies.push(refused(401));
    expect(await call(NOW)).toMatchObject({ kind: "provider_error", model: "test-luna", fallback: false, status: 401 });
    expect(plugin.calls).toHaveLength(1);
    expect(await latestCount()).toBe(0);
  });
});

describe("calls made on an earlier key", () => {
  const RECONNECTED = new Date("2026-11-27T09:30:00Z");

  it("keeps connected_at and the credit figure when Connect brings back the very same key, and moves them on for a different key", async () => {
    plugin = testPlugin("openrouter", { routers: ["openrouter/auto"], account: HAS_CREDIT });
    await recordTest(userId, "test-luna", "failed");
    await readAccountLive(env.DB, plugin, userId);
    const first = await connectedAt(env.DB, userId, "openrouter");
    await writeConnection(env.DB, userId, plugin, { method: "oauth_pkce", key_hash: "a".repeat(64) }, RECONNECTED);
    expect(await connectedAt(env.DB, userId, "openrouter")).toEqual(first);
    expect(await readHasCredit(env.DB, userId, "openrouter")).toBe(true);
    expect(await stateOf("test-luna")).toBe("failed");
    await writeConnection(env.DB, userId, plugin, { method: "oauth_pkce", key_hash: "b".repeat(64) }, RECONNECTED);
    expect(await connectedAt(env.DB, userId, "openrouter")).toEqual(RECONNECTED);
    // The new key's account is read again, live, by the first reader that needs it.
    expect(await readHasCredit(env.DB, userId, "openrouter")).toBeUndefined();
    expect((await readLatestTests(env.DB, userId, "openrouter")).get("test-luna")).toMatchObject({ earlierKey: true });
    plugin.account = NO_CREDIT;
    expect(await stateOf("test-luna")).toBe("credit");
    expect(await readHasCredit(env.DB, userId, "openrouter")).toBe(false);
  });
});
