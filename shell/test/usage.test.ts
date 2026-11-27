// Models › Usage: the month's OpenRouter spend from the ledger, per model and
// per task, against the budget as the shared budget bar shows it; names from
// OpenRouter's live list; honest labels on estimated costs; one next action
// when something is missing; and both tables dearest first, ties by name.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { clearAccessKeyCache } from "../src/access";
import { handleUsage, nameModels, taskName } from "../src/models/usage-page";
import { readMonthUsage, summariseUsage } from "../src/models/usage";
import { handleTaskModels } from "../src/models/picker-page";
import { USAGE_PATH, BUDGETS_PATH, PROVIDERS_PATH, TASK_MODELS_PATH } from "../src/paths";
import { CATALOG_VERSION } from "../src/prices/openrouter";
import { writeSnapshot } from "../src/prices/store";
import { disconnectProvider } from "../src/providers/check";
import { handleProviders } from "../src/providers/page";
import { setBudget } from "../src/proxy/budgets";
import { handleBudgets } from "../src/proxy/budgets-page";
import { writeConnection } from "../src/proxy/connections";
import { monthSpend, writeLedgerRow, type LedgerRow } from "../src/proxy/ledger";
import { ENV, generateKey, serveCerts, signToken } from "./access-fixture";
import { fakeFetch, ISSUED_KEY, keyReply } from "./fake-sources";
import { seedPrices, TEST_CATALOG, testPlugin, testSecrets, userFor } from "./test-plugin";

const NOW = new Date("2026-11-27T10:41:00Z");
const ORIGIN = "https://cos.example.com";
const HASH = "b".repeat(64);
let userId: string;

beforeEach(async () => {
  await seedPrices();
  userId = (await userFor("usage-sub")).id;
});

const call = (over: Partial<LedgerRow>) =>
  writeLedgerRow(env.DB, {
    userId, at: NOW, task: "cover_letter", site: "none", provider: "openrouter", model: "test-sonnet", region: "global", pluginVersion: "test", status: 200,
    inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, outputTokens: 100, longPrompt: false, durationMs: 10,
    costUsd: 0.5, costSource: "reported", costedConservatively: {}, ...over,
  });

// A month of calls: two models, three tasks, one call costed at list price,
// one refused, plus last month's call and another user's, which are not this
// user's month.
async function seedMonth() {
  await call({ costUsd: 1.25 });
  await call({ costUsd: 0.37, task: "fill_form", cachedInputTokens: 400, cacheWriteTokens: 50, cacheWrite1hTokens: 50 });
  await call({ model: "test-luna", task: "fill_form", costUsd: 0.1, costSource: "list_price" });
  await call({ model: "test-luna", task: "test_call", costUsd: 0, status: 429, inputTokens: 0, outputTokens: 0 });
  await call({ costUsd: 9, at: new Date("2026-10-31T23:59:59Z") });
  const other = (await userFor("someone-else")).id;
  await call({ userId: other, costUsd: 7 });
}

const page = async (fetcher = fakeFetch({ currentKey: () => keyReply({ usage_monthly: 1.5 }) })) => {
  const response = await handleUsage({ db: env.DB, userId, now: NOW, secrets: testSecrets(), fetcher });
  return { html: await response.text(), fetcher, response };
};

const connect = async () => {
  await writeConnection(env.DB, userId, testPlugin(), { method: "oauth_pkce", key_hash: HASH }, NOW);
  await testSecrets().put(userId, "openrouter", "key", ISSUED_KEY, NOW);
};

// The rows of one table, in order, by their names.
const rowNames = (html: string, table: "models" | "tasks") => {
  const t = html.match(new RegExp(`<table class="usage" id="by-${table}"[\\s\\S]*?</table>`))![0];
  return [...t.matchAll(/<tr>\n<td><span class="u-name">([^<]*)<\/span>/g)].map((m) => m[1]);
};

describe("the month's usage, from the ledger", () => {
  it("is per model, per task and in total from the same rows, and the total is the count that stops calls", async () => {
    await seedMonth();
    const usage = await readMonthUsage(env.DB, userId, NOW);
    expect(usage.since).toBe("2026-11-01T00:00:00.000Z");
    expect(usage.total).toEqual({ key: "", calls: 4, refused: 1, inputTokens: 3500, outputTokens: 300, costUsd: expect.closeTo(1.72, 10), estimatedUsd: 0.1 });
    expect(usage.byModel.map((l) => [l.key, l.calls, l.costUsd])).toEqual([["test-luna", 2, 0.1], ["test-sonnet", 2, 1.62]]);
    expect(usage.byTask.map((l) => [l.key, l.calls, l.costUsd, l.estimatedUsd])).toEqual([
      ["cover_letter", 1, 1.25, 0], ["fill_form", 2, 0.47, 0.1], ["test_call", 1, 0, 0],
    ]);
    const sum = (lines: { costUsd: number }[]) => lines.reduce((s, l) => s + l.costUsd, 0);
    expect(sum(usage.byModel)).toBeCloseTo(usage.total.costUsd, 10);
    expect(sum(usage.byTask)).toBeCloseTo(usage.total.costUsd, 10);
    expect(usage.total.costUsd).toBeCloseTo(await monthSpend(env.DB, userId, "openrouter", NOW), 10);
  });

  it("counts a row written before the ledger recorded how it was costed as estimated", async () => {
    await call({ costUsd: 0.2 });
    await env.DB.prepare("UPDATE model_calls SET cost_source = NULL WHERE user_id = ?").bind(userId).run();
    expect((await readMonthUsage(env.DB, userId, NOW)).total.estimatedUsd).toBe(0.2);
  });

  it("is empty, all zeros, before any call", () => {
    expect(summariseUsage([])).toEqual({ total: { key: "", calls: 0, refused: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, estimatedUsd: 0 }, byModel: [], byTask: [] });
  });
});

describe("names", () => {
  it("are OpenRouter's live names, with free only where its list says free, and the ID alone for a model no longer listed", () => {
    const line = (key: string) => ({ key, calls: 1, refused: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, estimatedUsd: 0 });
    const catalog = { ...TEST_CATALOG, models: [...TEST_CATALOG.models, { id: "maker/free-one:free", name: "Free One (free)", tools: true, free: true as const }] };
    expect(nameModels([line("test-sonnet"), line("maker/free-one:free"), line("gone/model")], catalog).map(({ key, name, listed, free }) => ({ key, name, listed, free }))).toEqual([
      { key: "test-sonnet", name: "Test Sonnet", listed: true, free: false },
      { key: "maker/free-one:free", name: "Free One (free)", listed: true, free: true },
      { key: "gone/model", name: "gone/model", listed: false, free: false },
    ]);
    expect(nameModels([line("test-sonnet")], undefined)[0]).toMatchObject({ name: "test-sonnet", listed: false });
  });

  it("are the task's own label, the test calls named, and an unknown task by its ID", () => {
    expect([taskName("cover_letter"), taskName("test_call"), taskName("test_all_models"), taskName("something_new")]).toEqual([
      "Cover letters", "Model tests", "Test all models", "something_new",
    ]);
  });
});

describe("the page", () => {
  it("shows the shared budget bar with the month's own count, and each table's foot is that same count", async () => {
    await connect();
    await setBudget(env.DB, userId, "openrouter", 30, "accepted", NOW);
    await seedMonth();
    const { html, fetcher } = await page();
    expect(html).toContain('<div class="bb" data-budget-bar>');
    // OpenRouter says $1.50; the app counted $1.72: the bar shows the larger.
    expect(html).toContain('<span class="big">$1.72</span><span class="of">/ $30 (6%)</span>');
    expect(html).toContain("$1.72 of $30 · $28.28 left");
    expect(html).toContain("The app's own count this month, which stops calls at the budget: $1.72.");
    expect(html).toContain('href="/chief-of-staff/models/setup/budgets">Change the budget</a>');
    expect(html.match(/<tfoot><tr><th scope="row">This month<span class="u-sub u-phone">4 calls<\/span><\/th><td class="num wide">4<\/td><td class="num wide">3,500<\/td><td class="num wide">300<\/td><td class="num">\$1\.72<\/td><\/tr><\/tfoot>/g)).toHaveLength(2);
    expect(html).toContain("From 1 November, at OpenRouter; starts again on 1 December.");
    expect(html).not.toContain(ISSUED_KEY);
    expect(fetcher.sent.map((s) => s.url)).toEqual(["https://openrouter.ai/api/v1/key"]);
    expect(html).not.toContain("data-next");
  });

  it("names each model as OpenRouter's list does, its ID second, and labels estimated and refused calls", async () => {
    await connect();
    await setBudget(env.DB, userId, "openrouter", 30, "accepted", NOW);
    await seedMonth();
    const { html } = await page();
    expect(html).toContain('<span class="u-name">Test Sonnet</span><span class="u-sub mono">test-sonnet</span><span class="u-sub u-phone">2 calls · 2,700 tokens</span>');
    expect(html).toContain('<span class="u-name">Test Luna</span><span class="u-sub mono">test-luna</span><span class="u-sub u-phone">2 calls · 1,100 tokens · 1 refused</span>');
    // Luna's only cost is at list price: all of it estimated.
    expect(html).toMatch(/<span class="u-name">Test Luna<\/span>[\s\S]*?\$0\.10 <span class="pill warn">estimated<\/span>/);
    // Filling forms is part reported, part list price.
    expect(html).toMatch(/<span class="u-name">Filling forms<\/span>[\s\S]*?\$0\.47<span class="u-sub">\$0\.10 of it estimated<\/span>/);
    expect(html).toMatch(/<span class="u-name">Test Sonnet<\/span>[\s\S]*?<td class="num">\$1\.62<\/td>/);
    expect(html).toMatch(/<span class="u-name">Test Luna<\/span>[\s\S]*?<td class="num wide">2<span class="u-sub">1 refused<\/span><\/td>\n<td class="num wide">1,000<\/td>\n<td class="num wide">100<\/td>/);
    expect(html).toContain("1,100 tokens · 1 refused");
    expect(html).not.toContain('class="pill free"');
  });

  it("marks a free model free, from OpenRouter's list, and a model no longer listed by its ID", async () => {
    await writeSnapshot(env.DB, {
      takenAt: "2026-11-27T07:00:00Z", status: "good", results: [], rows: [],
      catalog: { version: CATALOG_VERSION, readAt: "2026-11-27T07:00:00.000Z", models: [{ id: "maker/model:free", name: "Maker: Model (free)", tools: true, free: true }] },
    });
    await connect();
    await call({ model: "maker/model:free", costUsd: 0 });
    await call({ model: "test-sonnet", costUsd: 0.2 });
    const { html } = await page();
    expect(html).toContain('<span class="u-name">Maker: Model (free)</span> <span class="pill free">free</span><span class="u-sub mono">maker/model:free</span><span class="u-sub u-phone">');
    expect(html).toContain(`<span class="u-name">test-sonnet</span><span class="u-sub mono">test-sonnet · not in OpenRouter's list now</span><span class="u-sub u-phone">`);
  });

  it("lists both tables dearest first, ties by name, under plain headers", async () => {
    await connect();
    await call({ model: "test-sonnet", task: "cover_letter", costUsd: 0.2 });
    await call({ model: "test-luna", task: "fill_form", costUsd: 0.2 });
    await call({ model: "aaa/zzz", task: "test_call", costUsd: 0.5 });
    const { html } = await page();
    expect(rowNames(html, "models")).toEqual(["aaa/zzz", "Test Luna", "Test Sonnet"]);
    expect(rowNames(html, "tasks")).toEqual(["Model tests", "Cover letters", "Filling forms"]);
    expect(html).toContain('<thead><tr><th scope="col">Model</th><th scope="col" class="num wide">Calls</th><th scope="col" class="num wide">Input tokens</th><th scope="col" class="num wide">Output tokens</th><th scope="col" class="num">Cost</th></tr></thead>');
    expect(html).toContain('<thead><tr><th scope="col">Task</th>');
  });

  it("links Setup and Usage both ways", async () => {
    const { html } = await page();
    expect(html).toContain(`<nav class="subtabs" aria-label="Models"><a href="${PROVIDERS_PATH}">Setup</a><span class="on" aria-current="page">Usage</span></nav>`);
    await connect();
    const plugins = { openrouter: testPlugin() };
    const setup = [
      await (await handleProviders(new Request(`${ORIGIN}${PROVIDERS_PATH}`), { db: env.DB, plugins, readPlugins: async () => plugins, secrets: testSecrets(), userId, viewer: "owner", appOrigin: ORIGIN, now: NOW, fetcher: fakeFetch() })).text(),
      await (await handleBudgets(new Request(`${ORIGIN}${BUDGETS_PATH}`), env.DB, userId, NOW, { secrets: testSecrets(), fetcher: fakeFetch() })).text(),
      await (await handleTaskModels(new Request(`${ORIGIN}${TASK_MODELS_PATH}`), { db: env.DB, plugins, userId, viewer: "owner", now: NOW })).text(),
    ];
    for (const s of setup) expect(s).toContain(`<nav class="subtabs" aria-label="Models"><span class="on" aria-current="page">Setup</span><a href="${USAGE_PATH}">Usage</a></nav>`);
  });
});

describe("with nothing to show yet, the one next action", () => {
  const next = (html: string) => [...html.matchAll(/<a class="btn( small)?" href="([^"]+)" data-next>([^<]+)<\/a>/g)].map((m) => [m[2], m[3]]);

  it("is Connect OpenRouter, before it is connected", async () => {
    const { html, fetcher } = await page();
    expect(next(html)).toEqual([[PROVIDERS_PATH, "Connect OpenRouter"]]);
    expect(html).not.toContain(BUDGETS_PATH);
    expect(html).toContain("Once OpenRouter is connected, set a monthly budget for it.");
    expect(html).toContain('<span class="big">$0.00</span><span class="of">no budget set</span>');
    expect(html).toContain('<tr class="empty"><td colspan="5">No model calls this month yet.</td></tr>');
    expect(fetcher.sent).toHaveLength(0);
  });

  it("is Set a budget, once connected, and OpenRouter is not asked for a figure", async () => {
    await connect();
    const { html, fetcher } = await page();
    expect(next(html)).toEqual([[BUDGETS_PATH, "Set a budget"]]);
    expect(html).toContain("Model calls stay stopped until you set a monthly budget.");
    expect(html).not.toContain('<div class="bb" data-budget-bar>');
    expect(fetcher.sent).toHaveLength(0);
  });

  it("is Test a model, with a budget and no call this month, in each table's frame", async () => {
    await connect();
    await setBudget(env.DB, userId, "openrouter", 30, "accepted", NOW);
    const { html } = await page(fakeFetch({ currentKey: () => keyReply({ usage_monthly: 0 }) }));
    expect(next(html)).toEqual([[`${PROVIDERS_PATH}#test`, "Test a model"]]);
    expect(html).toContain('<tr class="empty"><td colspan="5">No model calls this month yet.</td></tr>');
    expect(html).toContain('<span class="big">$0.00</span><span class="of">/ $30 (0%)</span>');
    expect(html).toContain('<div class="bb" data-budget-bar>');
    expect(html).not.toContain("<tfoot>");
  });

  it("is Connect OpenRouter after a Disconnect, saying the month's figures are from before it", async () => {
    await connect();
    await setBudget(env.DB, userId, "openrouter", 30, "accepted", NOW);
    await seedMonth();
    await disconnectProvider(env.DB, testSecrets(), userId, "openrouter");
    const { html, fetcher } = await page();
    expect(html).toContain('<div class="banner next" role="note"><p>OpenRouter is disconnected. These figures are from before you disconnected.</p><a class="btn" href="/chief-of-staff/models/setup/providers" data-next>Connect OpenRouter</a></div>');
    expect(next(html)).toEqual([[PROVIDERS_PATH, "Connect OpenRouter"]]);
    expect(html).not.toContain("Its spend shows here once it is.");
    expect(html).toContain('<span class="big">$1.72</span><span class="of">/ $30 (6%)</span>');
    expect(rowNames(html, "models")).toEqual(["Test Sonnet", "Test Luna"]);
    expect(fetcher.sent).toHaveLength(0);
  });
});

describe("the route", () => {
  it("serves Models › Usage to the signed-in user only", async () => {
    clearAccessKeyCache();
    const key = await generateKey("kid-usage");
    serveCerts(() => [key]);
    const send = (headers: Record<string, string> = {}) =>
      worker.fetch(new Request(`${ORIGIN}${USAGE_PATH}`, { headers }), { ...ENV, DB: env.DB, APP_ORIGIN: ORIGIN });
    expect((await send()).status).toBe(403);
    const response = await send({ "cf-access-jwt-assertion": await signToken(key) });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Models · Usage · Chief of staff</title>");
  });
});
