// Models › Usage: the month's OpenRouter spend from the ledger, per model and
// per task, against the budget as the shared budget bar shows it; names from
// OpenRouter's live list; honest labels on estimated costs; one next action
// when something is missing; and both tables dearest first, ties by name.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { clearAccessKeyCache } from "../src/access";
import { BOX_ROWS, findText, handleUsage, nameModels, spendGap, taskName } from "../src/models/usage-page";
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
import { perModelBox } from "./maker-dom";
import live from "./fixtures/usage-gap-live.json";
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
  const response = await handleUsage({ db: env.DB, userId, now: NOW, secrets: testSecrets(), plugins: { openrouter: testPlugin() }, fetcher });
  return { html: await response.text(), fetcher, response };
};

const connect = async () => {
  await writeConnection(env.DB, userId, testPlugin(), { method: "oauth_pkce", key_hash: HASH }, NOW);
  await testSecrets().put(userId, "openrouter", "key", ISSUED_KEY, NOW);
};

// The rows of one table, in order, by their names.
const rowNames = (html: string, table: "models" | "tasks") => {
  const t = html.match(new RegExp(`<table class="usage" id="by-${table}"[\\s\\S]*?</table>`))![0];
  return [...t.matchAll(/<tr(?: data-[^>]*)?>\n<td><span class="u-name">([^<]*)<\/span>/g)].map((m) => m[1]);
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
    expect(summariseUsage([])).toEqual({ total: { key: "", calls: 0, refused: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, estimatedUsd: 0 }, byModel: [], byTask: [], beforeKeyUsd: 0 });
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
    expect(html).toContain(`<span class="small">$1.72 of $30 by the app's count · $28.28 left</span>`);
    expect(html).toContain("The app's own count this month, which stops calls at the budget: $1.72.");
    expect(html).toContain('href="/chief-of-staff/models/setup/budgets">Change the budget</a>');
    expect(html.match(/<tfoot><tr><th scope="row">This month<span class="u-sub u-phone">4 calls<\/span><\/th><td class="num wide">4<\/td><td class="num wide">3,500<\/td><td class="num wide">300<\/td><td class="num">\$1\.72<\/td><\/tr><\/tfoot>/g)).toHaveLength(2);
    expect(html).toContain("The app's own count since 1 November, the figure that stops calls at your budget. It starts again on 1 December.");
    expect(html).not.toContain(ISSUED_KEY);
    expect(fetcher.sent.map((s) => s.url)).toEqual(["https://openrouter.ai/api/v1/key"]);
    expect(html).not.toContain("data-next");
  });

  it("names each model as OpenRouter's list does, its ID second, and labels estimated and refused calls", async () => {
    await connect();
    await setBudget(env.DB, userId, "openrouter", 30, "accepted", NOW);
    await seedMonth();
    const { html } = await page();
    expect(html).toContain('<span class="u-name">Test Sonnet</span><span class="u-sub mono u-id" title="test-sonnet">test-sonnet</span><span class="u-sub u-phone">2 calls · 2,700 tokens</span>');
    expect(html).toContain('<span class="u-name">Test Luna</span><span class="u-sub mono u-id" title="test-luna">test-luna</span><span class="u-sub u-phone">2 calls · 1,100 tokens · 1 refused</span>');
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
    expect(html).toContain('<span class="u-name">Maker: Model (free)</span> <span class="pill free">free</span><span class="u-sub mono u-id" title="maker/model:free">maker/model:free</span><span class="u-sub u-phone">');
    expect(html).toContain(`<span class="u-name">test-sonnet</span><span class="u-sub mono u-id" title="test-sonnet">test-sonnet</span><span class="u-sub">Not in OpenRouter's list now</span><span class="u-sub u-phone">`);
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

describe("Per model's scroll box and search", () => {
  // A month with `n` models, each called once, named by the live list.
  async function manyModels(n: number) {
    const models = Array.from({ length: n }, (_, i) => ({ id: `maker-${i % 3}/model-${i}`, name: `Maker ${i % 3}: Model ${i}`, tools: true }));
    await writeSnapshot(env.DB, { takenAt: "2026-11-27T07:00:00Z", status: "good", results: [], rows: [], catalog: { version: CATALOG_VERSION, readAt: "2026-11-27T07:00:00.000Z", models } });
    await connect();
    for (const [i, m] of models.entries()) await call({ model: m.id, costUsd: 0.01 * (i + 1) });
  }
  const box = (html: string) => html.match(/<section class="card" aria-labelledby="by-models-h">[\s\S]*?<\/section>/)![0];

  it("holds the whole list in a box with the header and the month's total pinned, and a search over ten rows", async () => {
    await manyModels(BOX_ROWS + 2);
    const { html } = await page();
    const models = box(html);
    expect(models).toContain('<div class="tbl-wrap tbl-box" tabindex="0" role="region" aria-label="Per model, scrolls"><table class="usage" id="by-models"');
    // Every row is in the page, for no-script users; the search waits hidden for the script.
    expect(rowNames(html, "models")).toHaveLength(BOX_ROWS + 2);
    expect(models).toContain('<div class="find" data-find="by-models" data-noun="models" hidden>');
    expect(models).toContain('placeholder="Search name, maker or ID"');
    expect(models).toContain('<p class="count" data-count aria-live="polite">12 models</p>');
    expect(models).toContain('<tr class="empty" data-no-match hidden>');
    expect(models).toContain('<th scope="row"><span data-foot-label>This month</span>');
    // Still dearest first, and no sort control or form anywhere.
    expect(rowNames(html, "models")[0]).toBe("Maker 2: Model 11");
    expect(html.slice(html.indexOf("<body>"), html.indexOf("<script>"))).not.toMatch(/<form|class="th-sort|aria-sort/);
    // Per task stays a plain table: it has a row per task, about a dozen at most.
    expect(html).toContain('<div class="tbl-wrap"><table class="usage" id="by-tasks"');
  });

  it("has no search for ten rows or fewer", async () => {
    await manyModels(BOX_ROWS);
    const { html } = await page();
    expect(box(html)).toContain('class="tbl-wrap tbl-box"');
    expect(box(html)).not.toContain("data-find=");
    expect(box(html)).not.toContain("data-no-match");
  });

  it("matches any part of the readable name, the maker or the ID", () => {
    expect(findText({ key: "meta-llama/llama-3.1-8b", name: "Meta: Llama 3.1 8B", calls: 0, refused: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, estimatedUsd: 0 }))
      .toBe("meta: llama 3.1 8b meta-llama/llama-3.1-8b meta llama");
  });

  // Rows for the search script (test/maker-dom.ts), each from its find text.
  const searchPage = (texts: string[]) => perModelBox(texts.map((text) => ({ text, maker: text.split(":")[0]!, makerName: text.split(":")[0]! })));

  it("filters the rows as you type, in the page: no request, no reload, the address unchanged", () => {
    const p = searchPage(["openai: gpt-4o openai/gpt-4o openai", "anthropic: claude anthropic/claude anthropic", "meta: llama 3 meta-llama/llama-3 meta llama"]);
    expect(p.find.hidden).toBe(false);
    expect(p.count.textContent).toBe("3 models");
    expect(p.x.hidden).toBe(true);
    p.type("LLAMA");
    expect(p.trs.map((r) => r.hidden)).toEqual([true, true, false]);
    expect(p.count.textContent).toBe("1 of 3 models");
    expect(p.scroller.scrollTop).toBe(0);
    expect(p.x.hidden).toBe(false);
    p.type("open 4o");
    expect(p.trs.map((r) => r.hidden)).toEqual([false, true, true]);
    expect(p.none.hidden).toBe(true);
    expect(p.dispatch("keydown", p.input, "Enter").defaultPrevented).toBe(true);
    expect(p.sent).toEqual([]);
  });

  it("says when nothing matches, and Clear brings the whole list back", () => {
    const p = searchPage(["a: one a/one a", "b: two b/two b"]);
    p.type("zzz");
    expect(p.trs.every((r) => r.hidden)).toBe(true);
    expect(p.none.hidden).toBe(false);
    expect(p.said.textContent).toBe("zzz");
    expect(p.fromMakers.hidden).toBe(true);
    expect(p.count.textContent).toBe("0 of 2 models");
    p.dispatch("click", p.clear);
    expect(p.input.value).toBe("");
    expect(p.trs.some((r) => r.hidden)).toBe(false);
    expect(p.none.hidden).toBe(true);
    expect(p.input.focused).toBe(1);
    p.type("two");
    expect(p.dispatch("keydown", p.input, "Escape").defaultPrevented).toBe(true);
    expect(p.count.textContent).toBe("2 models");
    p.type("two");
    p.dispatch("click", p.x);
    expect(p.count.textContent).toBe("2 models");
    expect(p.sent).toEqual([]);
  });
});

describe("when OpenRouter's figure and the app's count differ", () => {
  const LATER = new Date("2026-11-20T08:15:00Z");
  const keyFetch = (usd: number) => fakeFetch({ currentKey: () => keyReply({ usage_monthly: usd }) });
  async function reconnectedOn(at: Date) {
    await writeConnection(env.DB, userId, testPlugin(), { method: "oauth_pkce", key_hash: HASH }, at);
    await testSecrets().put(userId, "openrouter", "key", ISSUED_KEY, at);
    await setBudget(env.DB, userId, "openrouter", 30, "accepted", NOW);
  }

  it("counts this month's calls made before the current key", async () => {
    await call({ costUsd: 0.35, at: new Date("2026-11-19T10:00:00Z") });
    await call({ costUsd: 0.2, at: new Date("2026-11-21T10:00:00Z") });
    await call({ costUsd: 9, at: new Date("2026-10-30T10:00:00Z") });
    expect((await readMonthUsage(env.DB, userId, NOW, LATER)).beforeKeyUsd).toBeCloseTo(0.35, 10);
    expect((await readMonthUsage(env.DB, userId, NOW)).beforeKeyUsd).toBe(0);
  });

  it("says the difference is calls made on an earlier key, when those account for it", async () => {
    await reconnectedOn(LATER);
    await call({ costUsd: 0.35, at: new Date("2026-11-19T10:00:00Z") });
    const { html } = await page(keyFetch(0));
    expect(html).toContain('<div class="gap"><p class="small">OpenRouter shows $0.00 for your current key; all $0.35 was spent this month on an earlier key.</p>');
    expect(html).toContain("<summary>Why the two figures differ</summary>");
    expect(html).toContain("the key the app holds now, made when you connected on 20 November at 08:15 UTC. Each Connect makes a new key.");
    expect(html).toContain(": $0.35 before that key was made, $0.00 since.");
    expect(html).toContain("<li>The app's count, $0.35, is what stops calls at your budget.</li>");
    expect(html).not.toContain("cannot tell");
  });

  it("says the other part was on an earlier key when the current key has spent too", async () => {
    await reconnectedOn(LATER);
    await call({ costUsd: 0.35, at: new Date("2026-11-19T10:00:00Z") });
    await call({ costUsd: 0.1, at: new Date("2026-11-25T10:00:00Z") });
    const { html } = await page(keyFetch(0.1));
    expect(html).toContain("OpenRouter shows $0.10 for your current key; the other $0.35 was spent this month on an earlier key.");
  });

  it("says only that they differ, and which one stops calls, when the app cannot tell why", async () => {
    await reconnectedOn(LATER);
    await call({ costUsd: 0.4, at: new Date("2026-11-25T10:00:00Z") });
    const { html } = await page(keyFetch(0.1));
    expect(html).toContain("<p class=\"small\">OpenRouter's figure for your current key, $0.10, and the app's count, $0.40, differ.</p>");
    expect(html).toContain("<li>The app's count, $0.40, is what stops calls at your budget.</li>");
    expect(html).toContain("The app cannot tell what the rest of the difference is.");
    expect(html).not.toContain("earlier key.");
  });

  it("heads the card with the app's count, against the budget, when OpenRouter's figure is the larger", async () => {
    await reconnectedOn(LATER);
    await call({ costUsd: 0.2, at: new Date("2026-11-25T10:00:00Z") });
    const { html } = await page(keyFetch(0.9));
    expect(html).toContain('<span class="big">$0.20</span><span class="of">/ $30 (under 1%)</span>');
    expect(html).toContain(`<span class="small">$0.90 of $30 by OpenRouter's figure · $29.10 left</span>`);
    expect(html).toContain("OpenRouter's figure for your current key, $0.90, and the app's count, $0.20, differ.");
  });

  it("says nothing when they agree", async () => {
    expect(spendGap(0.35, { usage: { monthlyUsd: 0.351 } as never, readAt: NOW.toISOString() }, 0)).toBeUndefined();
    expect(spendGap(0.35, { unread: "OpenRouter did not answer" }, 0.35)).toBeUndefined();
    await reconnectedOn(LATER);
    await call({ costUsd: 0.2, at: new Date("2026-11-25T10:00:00Z") });
    expect((await page(keyFetch(0.2))).html).not.toContain('<div class="gap">');
  });

  it("says, in one line with no budget set, when OpenRouter's figure could not be read, and why", async () => {
    await writeConnection(env.DB, userId, testPlugin(), { method: "oauth_pkce", key_hash: HASH }, LATER);
    await testSecrets().put(userId, "openrouter", "key", ISSUED_KEY, LATER);
    await call({ costUsd: 0.2, at: new Date("2026-11-25T10:00:00Z") });
    const { html } = await page(fakeFetch({ currentKey: () => new Response("upstream down", { status: 503 }) }));
    expect(html).toContain('<span class="of">no budget set</span>');
    expect(html).toContain('<div class="gap"><p class="small">The app could not read OpenRouter\'s figure for your current key just now, so it cannot check its count against it: OpenRouter refused the request (status 503).</p></div>');
    expect(html).not.toContain("Why the two figures differ");
  });

  it("leaves that line to the bar's own source line once a budget is set", async () => {
    await reconnectedOn(LATER);
    await call({ costUsd: 0.2, at: new Date("2026-11-25T10:00:00Z") });
    const { html } = await page(fakeFetch({ currentKey: () => new Response("upstream down", { status: 503 }) }));
    expect(html).toContain("OpenRouter's own figure could not be read just now (OpenRouter refused the request (status 503)), so the bar shows the app's own count this month");
    expect(html).toContain(`<span class="small">$0.20 of $30 by the app's count · $29.80 left</span>`);
    expect(html).not.toContain("The app could not read OpenRouter's figure");
    expect(html).not.toContain('<div class="gap">');
  });

  it("says so on a $0 key with no budget set too, from the same read Providers makes", async () => {
    await writeConnection(env.DB, userId, testPlugin(), { method: "oauth_pkce", key_hash: HASH }, LATER);
    await testSecrets().put(userId, "openrouter", "key", ISSUED_KEY, LATER);
    await call({ costUsd: 0.35, at: new Date("2026-11-19T10:00:00Z") });
    const { html, fetcher } = await page(keyFetch(0));
    expect(fetcher.sent.map((s) => s.url)).toEqual(["https://openrouter.ai/api/v1/key"]);
    expect(html).toContain("OpenRouter shows $0.00 for your current key; all $0.35 was spent this month on an earlier key.");
    expect(html).toContain('<span class="of">no budget set</span>');
  });
});

// The owner's month on the live site (fixtures/usage-gap-live.json): every
// call made before the current key, no budget set, and OpenRouter's figure
// for the current key $0, the figure Providers shows as "key spent $0". The
// page read that figure only once a budget was set, so it showed $0.35 "at
// OpenRouter" and no line on why OpenRouter's figure was $0.
describe("the owner's live month: no budget, every call on an earlier key", () => {
  const NOW_LIVE = new Date(live.now);
  async function seedLive() {
    await writeConnection(env.DB, userId, testPlugin(), { method: "oauth_pkce", key_hash: HASH }, new Date(live.connectedAt));
    await testSecrets().put(userId, "openrouter", "key", ISSUED_KEY, new Date(live.connectedAt));
    for (const [at, task, model, status, input, cached, write, write1h, output, cost, source] of live.rows as [string, string, string, number, number, number, number, number, number, number, "reported" | "list_price"][]) {
      await call({ at: new Date(at), task, model, status, inputTokens: input, cachedInputTokens: cached, cacheWriteTokens: write, cacheWrite1hTokens: write1h, outputTokens: output, costUsd: cost, costSource: source });
    }
  }
  const livePage = async () => {
    const fetcher = fakeFetch({ currentKey: () => keyReply(live.keyReply) });
    const response = await handleUsage({ db: env.DB, userId, now: NOW_LIVE, secrets: testSecrets(), plugins: { openrouter: testPlugin() }, fetcher });
    return { html: await response.text(), fetcher };
  };

  it("reads OpenRouter's figure for the current key, as Providers does, and says all of the month was on an earlier key", async () => {
    await seedLive();
    const usage = await readMonthUsage(env.DB, userId, NOW_LIVE, new Date(live.connectedAt));
    expect(usage.total.calls).toBe(423);
    expect(usage.total.costUsd).toBeCloseTo(0.349393, 6);
    expect(usage.beforeKeyUsd).toBeCloseTo(usage.total.costUsd, 10);
    const { html, fetcher } = await livePage();
    expect(fetcher.sent.map((s) => s.url)).toEqual(["https://openrouter.ai/api/v1/key"]);
    expect(html).toContain("OpenRouter shows $0.00 for your current key; all $0.35 was spent this month on an earlier key.");
    expect(html).toContain("made when you connected on 27 November at 15:03 UTC");
  });

  it("labels the headline as the app's own count, never as OpenRouter's", async () => {
    await seedLive();
    const { html } = await livePage();
    expect(html).toContain('<span class="big">$0.35</span><span class="of">no budget set</span>');
    expect(html).not.toContain("at OpenRouter;");
    expect(html).toContain("The app's own count since 1 November, the figure that stops calls at your budget. It starts again on 1 December.");
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

  it("is Set a budget, once connected, with OpenRouter's figure for the key still read", async () => {
    await connect();
    const { html, fetcher } = await page(fakeFetch({ currentKey: () => keyReply({ usage_monthly: 0 }) }));
    expect(next(html)).toEqual([[BUDGETS_PATH, "Set a budget"]]);
    expect(html).toContain("Model calls stay stopped until you set a monthly budget.");
    expect(html).not.toContain('<div class="bb" data-budget-bar>');
    expect(html).not.toContain('<div class="gap">');
    expect(fetcher.sent.map((s) => s.url)).toEqual(["https://openrouter.ai/api/v1/key"]);
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
