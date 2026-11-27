// Models › Usage: the month's OpenRouter spend from the ledger, per model and
// per task, against the budget as the shared budget bar shows it; names from
// OpenRouter's live list; honest labels on estimated costs; one next action
// when something is missing; and sorting in the page with no request.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { clearAccessKeyCache } from "../src/access";
import { handleUsage, nameModels, nextSort, parseUsageSort, SORT_JS, sortLines, taskName, type NamedLine } from "../src/models/usage-page";
import { readMonthUsage, summariseUsage } from "../src/models/usage";
import { handleTaskModels } from "../src/models/picker-page";
import { USAGE_PATH, BUDGETS_PATH, PROVIDERS_PATH, TASK_MODELS_PATH } from "../src/paths";
import { CATALOG_VERSION } from "../src/prices/openrouter";
import { writeSnapshot } from "../src/prices/store";
import { handleProviders } from "../src/providers/page";
import { setBudget } from "../src/proxy/budgets";
import { handleBudgets } from "../src/proxy/budgets-page";
import { writeConnection } from "../src/proxy/connections";
import { monthSpend, writeLedgerRow, type LedgerRow } from "../src/proxy/ledger";
import { ENV, generateKey, serveCerts, signToken } from "./access-fixture";
import { fakeFetch, ISSUED_KEY, keyReply } from "./fake-sources";
import { runScript, type Sent } from "./script-dom";
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

const page = async (query = "", fetcher = fakeFetch({ currentKey: () => keyReply({ usage_monthly: 1.5 }) })) => {
  const response = await handleUsage(new Request(`${ORIGIN}${USAGE_PATH}${query}`), { db: env.DB, userId, now: NOW, secrets: testSecrets(), fetcher });
  return { html: await response.text(), fetcher, response };
};

const connect = async () => {
  await writeConnection(env.DB, userId, testPlugin(), { method: "oauth_pkce", key_hash: HASH }, NOW);
  await testSecrets().put(userId, "openrouter", "key", ISSUED_KEY, NOW);
};

// The rows of one table, in order, by their names.
const rowNames = (html: string, table: "models" | "tasks") => {
  const t = html.match(new RegExp(`<table class="usage" id="by-${table}"[\\s\\S]*?</table>`))![0];
  return [...t.matchAll(/<tr data-name="([^"]*)"/g)].map((m) => m[1]);
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
    expect(html).toMatch(/<tr data-name="test luna"[\s\S]*?\$0\.10 <span class="pill warn">estimated<\/span>/);
    // Filling forms is part reported, part list price.
    expect(html).toMatch(/<tr data-name="filling forms"[\s\S]*?\$0\.47<span class="u-sub">\$0\.10 of it estimated<\/span>/);
    expect(html).toMatch(/<tr data-name="test sonnet"[\s\S]*?<td class="num">\$1\.62<\/td>/);
    expect(html).toMatch(/<tr data-name="test luna"[\s\S]*?<td class="num wide">2<span class="u-sub">1 refused<\/span><\/td>\n<td class="num wide">1,000<\/td>\n<td class="num wide">100<\/td>/);
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

  it("sorts dearest first, and by the address without a script", async () => {
    await connect();
    await seedMonth();
    expect(rowNames((await page()).html, "models")).toEqual(["test sonnet", "test luna"]);
    expect(rowNames((await page()).html, "tasks")).toEqual(["cover letters", "filling forms", "model tests"]);
    const { html } = await page("?models=name:asc&tasks=calls:desc");
    expect(rowNames(html, "models")).toEqual(["test luna", "test sonnet"]);
    expect(rowNames(html, "tasks")).toEqual(["filling forms", "cover letters", "model tests"]);
    // Each header links to its next order, keeping the other table's.
    expect(html).toContain('<th scope="col" aria-sort="ascending"><a class="th-sort" href="?models=name:desc&tasks=calls:desc" data-sort="name">Model');
    expect(html).toContain('<th scope="col" class="num" aria-sort="none"><a class="th-sort" href="?models=cost:desc&tasks=calls:desc" data-sort="cost">Cost');
    expect(parseUsageSort("bogus:up")).toEqual({ column: "cost", dir: "desc" });
    expect(nextSort({ column: "cost", dir: "desc" }, "cost")).toEqual({ column: "cost", dir: "asc" });
    expect(nextSort({ column: "cost", dir: "desc" }, "name")).toEqual({ column: "name", dir: "asc" });
    expect(nextSort({ column: "name", dir: "asc" }, "calls")).toEqual({ column: "calls", dir: "desc" });
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
    const { html } = await page("", fakeFetch({ currentKey: () => keyReply({ usage_monthly: 0 }) }));
    expect(next(html)).toEqual([[`${PROVIDERS_PATH}#test`, "Test a model"]]);
    expect(html).toContain('<tr class="empty"><td colspan="5">No model calls this month yet.</td></tr>');
    expect(html).toContain('<span class="big">$0.00</span><span class="of">/ $30 (0%)</span>');
    expect(html).toContain('<div class="bb" data-budget-bar>');
    expect(html).not.toContain("<tfoot>");
  });
});

describe("sorting in the page", () => {
  // A stand-in table: header links and rows, as the page renders them.
  function table(id: "models" | "tasks", rows: Array<[string, number, number]>, sorted: string) {
    const listeners: Record<string, Array<(e: { preventDefault: () => void }) => void>> = {};
    const links = (["name", "calls", "cost"] as const).map((column) => {
      const th = { attrs: { "aria-sort": column === sorted ? "descending" : "none" } as Record<string, string>, getAttribute(n: string) { return this.attrs[n] ?? null; }, setAttribute(n: string, v: string) { this.attrs[n] = v; } };
      const arrow = { textContent: column === sorted ? "▼" : "" };
      const link = {
        column, attrs: { "data-sort": column, href: "" } as Record<string, string>, parentElement: th, arrow,
        getAttribute(n: string) { return this.attrs[n] ?? null; }, setAttribute(n: string, v: string) { this.attrs[n] = v; },
        querySelector: () => arrow,
        addEventListener: (type: string, fn: (e: { preventDefault: () => void }) => void) => { (listeners[`${column}:${type}`] ??= []).push(fn); },
      };
      Object.assign(th, { querySelector: () => link });
      return link;
    });
    const order = rows.map(([name, calls, cost]) => ({ attrs: { "data-name": name, "data-calls": String(calls), "data-cost": String(cost) } as Record<string, string>, getAttribute(n: string) { return this.attrs[n] ?? null; } }));
    const body = {
      rows: [...order],
      querySelectorAll: () => body.rows,
      appendChild(r: (typeof order)[number]) { body.rows = [...body.rows.filter((x) => x !== r), r]; },
    };
    const el = {
      getAttribute: (n: string) => (n === "data-sort-table" ? id : null),
      querySelector: (s: string) => (s === "tbody" ? body : s.startsWith("th[aria-sort") ? links.find((l) => l.parentElement.attrs["aria-sort"] !== "none")?.parentElement : null),
      querySelectorAll: () => links,
    };
    let prevented = 0;
    const click = (column: string) => listeners[`${column}:click`]!.forEach((fn) => fn({ preventDefault: () => { prevented++; } }));
    return { el, body, links, click, names: () => body.rows.map((r) => r.attrs["data-name"]), prevented: () => prevented };
  }

  it("reorders the rows, marks the column and keeps the order in the address, loading nothing", () => {
    const models = table("models", [["test sonnet", 2, 1.62], ["test luna", 5, 0.1], ["aurora", 5, 0.4]], "cost");
    const tasks = table("tasks", [["cover letters", 1, 1.25]], "cost");
    const sent: Sent = [];
    const replaced: string[] = [];
    const document = { querySelectorAll: () => [models.el, tasks.el] };
    const history = { replaceState: (_s: unknown, _t: string, u: string) => replaced.push(u) };
    runScript(SORT_JS, document, `${ORIGIN}${USAGE_PATH}`, sent, { window: { history } });
    models.click("name");
    expect(models.names()).toEqual(["aurora", "test luna", "test sonnet"]);
    expect(models.links.map((l) => l.parentElement.attrs["aria-sort"])).toEqual(["ascending", "none", "none"]);
    expect(models.links[0]!.arrow.textContent).toBe("▲");
    expect(models.links[0]!.attrs.href).toBe("?models=name:desc&tasks=cost:desc");
    expect(tasks.links[2]!.attrs.href).toBe("?models=name:asc&tasks=cost:asc");
    models.click("calls");
    // Largest first; ties by name.
    expect(models.names()).toEqual(["aurora", "test luna", "test sonnet"]);
    models.click("calls");
    expect(models.names()).toEqual(["test sonnet", "aurora", "test luna"]);
    expect(replaced).toEqual([`${USAGE_PATH}?models=name:asc&tasks=cost:desc`, `${USAGE_PATH}?models=calls:desc&tasks=cost:desc`, `${USAGE_PATH}?models=calls:asc&tasks=cost:desc`]);
    expect(models.prevented()).toBe(3);
    expect(sent).toEqual([]);
  });

  it("sorts on the server as the script does", () => {
    const l = (name: string, calls: number, costUsd: number): NamedLine => ({ key: name, name, calls, costUsd, refused: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 });
    const lines = [l("test sonnet", 2, 1.62), l("test luna", 5, 0.1), l("aurora", 5, 0.4)];
    expect(sortLines(lines, { column: "calls", dir: "desc" }).map((x) => x.name)).toEqual(["aurora", "test luna", "test sonnet"]);
    expect(sortLines(lines, { column: "calls", dir: "asc" }).map((x) => x.name)).toEqual(["test sonnet", "aurora", "test luna"]);
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
