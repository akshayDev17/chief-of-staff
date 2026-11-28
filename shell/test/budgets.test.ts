// Models › Setup › Budgets (design-v3 1.8): the one monthly OpenRouter
// budget, its suggestion from the tasks' models (or, before a task has one,
// the Ready models proposed for them) at OpenRouter's list prices,
// and setting and changing it in place or, without the script, by
// post-redirect-get. Every request goes through the Worker, Access included,
// against a D1 with every migration applied.
import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { saveAccountList } from "../src/models/account-list";
import { savePriceCap } from "../src/models/price-caps";
import { CATALOG_VERSION } from "../src/prices/openrouter";
import { writeSnapshot } from "../src/prices/store";
import { monthlyFor, parseBudget, readBudget, readSuggestionBasis, setBudget, suggest, TOKENS_PER_APPLICATION } from "../src/proxy/budgets";
import { saveHasCredit, writeConnection } from "../src/proxy/connections";
import { writeLedgerRow } from "../src/proxy/ledger";
import { ENV, generateKey, serveCerts, signToken, type TestKey } from "./access-fixture";
import { element, pageScripts, runScript, type Sent } from "./script-dom";
import { recordTest, row, seedPrices, TEST_CATALOG, testPlugin, userFor } from "./test-plugin";

const NOW = new Date("2026-11-25T10:00:00Z");
// The plug-in the direct reads use; the Worker's own reads the stored list.
const plugins = { openrouter: testPlugin("openrouter", { routers: ["openrouter/auto"] }) };
const basisNow = () => readSuggestionBasis(env.DB, plugins, ownerId);
const dropRoutes = () => env.DB.prepare("DELETE FROM task_routes").run();
// The owner's account's own list, leaving out `models`: they are not Ready.
const leaveOut = (...models: string[]) =>
  saveAccountList(env.DB, ownerId, "openrouter", TEST_CATALOG.models.map((m) => m.id).concat("openrouter/auto").filter((id) => !models.includes(id)), NOW);
const BASE = "https://shell.test/chief-of-staff/models/setup/budgets";
let key: TestKey;

beforeAll(async () => {
  key = await generateKey("kid-budgets");
});
afterEach(() => vi.restoreAllMocks());

// The signed-in user is the Access token's subject (access-fixture: "test-sub").
const send = async (path: string, init: RequestInit = {}, claims: Record<string, unknown> = {}): Promise<Response> => {
  serveCerts(() => [key]);
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", await signToken(key, claims));
  return worker.fetch(new Request(`${BASE}${path}`, { ...init, headers, redirect: "manual" }), { ...ENV, DB: env.DB });
};
const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  send("", { method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });
// As the page's script sends it: in place, asking for JSON.
const postInPlace = async (fields: Record<string, string>) => {
  const r = await post(fields, { accept: "application/json" });
  return { status: r.status, location: r.headers.get("location"), body: (await r.json()) as { main: string; focus?: string } };
};
const page = async (path = "", headers: Record<string, string> = {}) => (await send(path, { headers })).text();
const flashOf = (r: Response) => r.headers.get("set-cookie")!.split(";")[0]!;
const primaries = (html: string) => html.match(/class="btn primary[^"]*"/g)?.length ?? 0;

let ownerId: string;

const routeTask = (userId: string, task: string, main: string, fallback?: string) =>
  env.DB.prepare(
    "INSERT INTO task_routes (user_id, task, main_provider, main_model, fallback_provider, fallback_model, set_how, set_at) VALUES (?, ?, 'openrouter', ?, ?, ?, 'changed', ?)",
  )
    .bind(userId, task, main, fallback ? "openrouter" : null, fallback ?? null, NOW.toISOString())
    .run();

beforeEach(async () => {
  await seedPrices();
  ownerId = (await userFor("test-sub")).id;
  await writeConnection(env.DB, ownerId, testPlugin(), { method: "oauth_pkce", key_hash: "a".repeat(64) }, NOW);
  // The account has credit, as its last live read said: every priced model is Ready.
  await saveHasCredit(env.DB, ownerId, "openrouter", true);
  // A Middle task runs on the Strongest Test Sonnet, kept from before.
  await routeTask(ownerId, "score", "test-sonnet");
});

describe("the suggested budget", () => {
  it("is the dearest model the tasks use at OpenRouter's list prices and the design's tokens, a month of days", async () => {
    const basis = (await basisNow())!;
    // (51,100 × $3 + 3,225 × $15) per million = $0.201675 an application; × 5 × 30 = $30.25, rounded up.
    expect(TOKENS_PER_APPLICATION).toEqual({ input: 51_100, output: 3_225 });
    expect(basis).toEqual({
      from: "tasks",
      perApplicationUsd: 0.201675,
      model: { model: "test-sonnet", name: "Test Sonnet", inputUsdPerMTok: 3, outputUsdPerMTok: 15, free: false, capped: false, checkedOn: "2026-11-27" },
    });
    expect(suggest(basis, 5).monthlyUsd).toBe(31);
    expect(suggest(basis, 10).monthlyUsd).toBe(61);
    expect(monthlyFor(0, 5)).toBe(1);
  });

  it("is worked from the models the tasks use, main or fallback", async () => {
    await dropRoutes();
    await routeTask(ownerId, "match", "test-mini");
    expect(await basisNow()).toMatchObject({ from: "tasks", model: { model: "test-mini" }, perApplicationUsd: 0.016 });
    await routeTask(ownerId, "score", "test-mini", "test-sonnet");
    expect(await basisNow()).toMatchObject({ from: "tasks", model: { model: "test-sonnet" } });
  });

  it("is worked from the Ready models proposed for the tasks before a task uses one, ignores one the provider no longer offers, and has none before any is Ready", async () => {
    await dropRoutes();
    await routeTask(ownerId, "match", "test-gone");
    // The Smallest tasks are proposed Test Luna with Test Mini; no Middle model is Ready.
    expect(await basisNow()).toMatchObject({ from: "proposed", model: { model: "test-mini" }, perApplicationUsd: 0.016 });
    // A failed call leaves a model Ready; the account's settings leaving them out does not.
    await recordTest(ownerId, "test-luna", "failed", "2026-11-27T09:30:00.000Z");
    expect(await basisNow()).toMatchObject({ from: "proposed", model: { model: "test-mini" } });
    await leaveOut("test-luna", "test-mini");
    expect(await basisNow()).toBeUndefined();
  });

  it("follows the current model list's prices, and leaves out a model the list no longer has", async () => {
    await writeSnapshot(env.DB, {
      takenAt: "2026-11-28T06:00:00Z", status: "good", results: [],
      catalog: { ...TEST_CATALOG, models: TEST_CATALOG.models.filter((m) => m.id !== "test-sonnet").concat({ id: "test-mini", name: "Test Mini 2", tools: true }).filter((m, i, a) => a.findIndex((x) => x.id === m.id) === i) },
      rows: [{ ...row("test-mini", "input", 2), dateRead: "2026-11-28" }, { ...row("test-mini", "output", 8), dateRead: "2026-11-28" }],
    });
    // Test Sonnet is no longer listed: the proposals are Test Luna (Smallest) and Test Mini, Middle now.
    expect(await basisNow()).toMatchObject({ from: "proposed", model: { model: "test-mini", inputUsdPerMTok: 2, outputUsdPerMTok: 8, checkedOn: "2026-11-28" } });
  });

  it("prices a router a task uses at the user's own price cap on it", async () => {
    await savePriceCap(env.DB, ownerId, "openrouter", "openrouter/auto", { input: 10, output: 40 }, new Date("2026-11-26T08:00:00Z"));
    await routeTask(ownerId, "match", "openrouter/auto");
    expect(await basisNow()).toMatchObject({
      model: { model: "openrouter/auto", name: "Auto router", inputUsdPerMTok: 10, outputUsdPerMTok: 40, capped: true, checkedOn: "2026-11-26" },
    });
  });

  describe("when every model it could be worked from is free", () => {
    const free = { id: "maker/free-one:free", name: "Maker: Free One (free)", tools: true, free: true as const };
    beforeEach(async () => {
      await writeSnapshot(env.DB, {
        takenAt: "2026-11-28T06:00:00Z", status: "good", results: [],
        catalog: { ...TEST_CATALOG, models: [...TEST_CATALOG.models, free] },
        // Test Sonnet stays priced and Ready: only the tasks' choices make the basis free.
        rows: [row(free.id, "input", 0), row(free.id, "output", 0), row("test-sonnet", "input", 3), row("test-sonnet", "output", 15)],
      });
      await dropRoutes();
    });

    it("names $1 the floor, the smallest budget that switches calls on, not a dearest model's estimate", async () => {
      await routeTask(ownerId, "match", free.id);
      const html = await page("?per_day=50");
      expect(html).toContain('<p class="label">Suggested <span class="pill">floor</span></p>');
      expect(html).toContain('<span class="num big" data-sugg>$1</span> <span class="unit">a month</span>');
      expect(html).toContain('<p class="from">The smallest budget that switches model calls on.</p>\n<p class="from">Your tasks use only free models.</p>');
      expect(html).toContain("<li>Every model your tasks use is free on OpenRouter's list, so a call costs nothing.</li>");
      expect(html).toContain("Set $1 a month");
      for (const gone of ["dearest", "estimate", "checked on", "data-per-day ", "Applications a day you plan"]) expect(html).not.toContain(gone);
      expect(html).not.toContain('<div class="bb" data-budget-bar>');
    });

    it("says the Ready models the tasks would get are all free before any task has one", async () => {
      const html = await page();
      expect(html).toContain('<p class="from">Your Ready models for tasks are all free.</p>');
      expect(html).not.toContain("dearest");
    });

    it("names the floor once the budget is set, with no about", async () => {
      await routeTask(ownerId, "match", free.id);
      await setBudget(env.DB, ownerId, "openrouter", 5, "typed", NOW);
      const html = await page();
      expect(html).toContain('<summary>Suggested: <span data-sugg>$1</span> a month, the floor</summary>');
      expect(html).not.toContain("dearest");
    });

    it("goes back to the paid model's estimate once a task uses one", async () => {
      await routeTask(ownerId, "match", free.id, "test-sonnet");
      const html = await page("?per_day=5");
      expect(html).toContain('<span class="pill warn">estimate</span>');
      expect(html).toContain("From <strong>Test Sonnet</strong>, the dearest model your tasks use.");
      expect(html).not.toContain("floor");
    });
  });

  it("parses any positive dollar amount, with no upper limit", () => {
    expect(parseBudget("30")).toBe(30);
    expect(parseBudget(" $1,250.50 ")).toBe(1250.5);
    expect(parseBudget("25000")).toBe(25000);
    for (const bad of ["", "0", "-5", "abc", "1e3", "10.123", "9".repeat(400)]) expect(parseBudget(bad)).toBeUndefined();
  });
});

describe("Models › Setup › Budgets, before the budget is set", () => {
  it("suggests a value with its basis, marked estimate with its checked-on date, and one tap to set it", async () => {
    const html = await page("?per_day=5");
    expect(html).toContain('<p class="label">Suggested <span class="pill warn">estimate</span> <span class="meta">checked on 2026&#8209;11&#8209;27</span></p>');
    expect(html).toContain('<span class="num big" data-sugg>$31</span> <span class="unit">a month</span>');
    expect(html).toContain('From <strong>Test Sonnet</strong>, the dearest model your tasks use.');
    expect(html).toContain("<li>Its price on OpenRouter's list: $3.00 in, $15.00 out per million tokens, read 2026&#8209;11&#8209;27.</li>");
    expect(html).toMatch(/<button type="submit" class="btn primary wide" name="do" value="accept" data-k="accept" data-accept data-label="Set \{usd\} a month">Set \$31 a month<\/button>/);
    expect(html).toContain("Model calls stay stopped until it is set. Tests still run.");
    expect(html).not.toContain('<div class="bb" data-budget-bar>');
    expect(primaries(html)).toBe(1);
  });

  it("keeps every visible sentence to 12 words or fewer, the basis under How this is worked out", async () => {
    for (const html of [await page("?per_day=5"), (await setBudget(env.DB, ownerId, "openrouter", 31, "accepted", NOW), await page("?per_day=5"))]) {
      const visible = html
        .replace(/<(style|script|title)[\s\S]*?<\/\1>/g, " ")
        .replace(/<details[\s\S]*?<\/details>/g, " ")
        .replace(/<div class="bb" data-budget-bar>[\s\S]*?<\/div>\n<\/div>/g, " ")
        .replace(/<\/?(?:p|h\d|li|ul|div|section|form|label|button|input|main|body|nav)\b[^>]*>/g, "\n")
        .replace(/<[^>]+>/g, " ");
      const sentences = visible.split(/\n|(?<=[.:?!])\s/).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
      for (const sentence of sentences) expect(sentence.split(" ").length, sentence).toBeLessThanOrEqual(12);
    }
  });

  it("says what the month has spent already, which the budget counts, only once there is some", async () => {
    expect(await page()).not.toContain("Already spent this month");
    await writeLedgerRow(env.DB, {
      userId: ownerId, at: NOW, task: "model_test", site: "", provider: "openrouter", model: "test-sonnet", region: "global", pluginVersion: "test", status: 200,
      inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, outputTokens: 10, longPrompt: false, durationMs: 10,
      costUsd: 1.234, costSource: "reported", costedConservatively: {},
    });
    expect(await page()).toContain('<p class="stop">Already spent this month: $1.23. The budget counts it.</p>');
  });

  it("works the suggestion at the volume asked for, 5 a day when none is", async () => {
    expect(await page("?per_day=10")).toContain("Set $61 a month");
    expect(await page("")).toContain('value="5" aria-label="Applications a day you plan"');
    expect(await page("?per_day=nope")).toContain("Set $31 a month");
  });

  it("gives a direct action when there is no suggestion: See models, with Set budget the one primary", async () => {
    await dropRoutes();
    await leaveOut("test-luna", "test-mini");
    const html = await page();
    expect(html).toContain("No suggestion yet: no model is ready.");
    expect(html).toContain('<a class="btn outline" href="/chief-of-staff/models/setup/providers#test" data-k="test">See models</a>');
    expect(html).toMatch(/<button type="submit" class="btn primary" name="do" value="set" data-k="set">Set budget<\/button>/);
    expect(primaries(html)).toBe(1);
  });

  it("asks a user who has not connected OpenRouter to connect it, straight to OpenRouter", async () => {
    const html = await page("", {});
    expect(html).not.toContain("Not connected");
    const friend = await (await send("", {}, { sub: "friend-sub", email: "friend@example.com" })).text();
    expect(friend).toContain('<form method="post" action="/chief-of-staff/models/setup/providers/openrouter/connect"><button type="submit" class="btn primary wide" data-k="connect">Connect OpenRouter</button></form>');
    expect(friend).not.toContain('name="amount"');
    expect(primaries(friend)).toBe(1);
  });
});

describe("setting and changing the budget", () => {
  it("sets the suggestion in place: JSON with the new <main>, the bar, no redirect", async () => {
    const r = await postInPlace({ do: "accept", per_day: "5" });
    expect(r.status).toBe(200);
    expect(r.location).toBeNull();
    expect(r.body.focus).toBe("next");
    expect(await readBudget(env.DB, ownerId, "openrouter")).toMatchObject({ monthlyUsd: 31, setHow: "accepted" });
    expect(r.body.main).toContain('<div class="banner ok" role="status">Budget set: $31 a month.</div>');
    expect(r.body.main).toContain('<div class="bb" data-budget-bar>');
    expect(r.body.main).toContain('<span class="num big">$31</span> <span class="unit">a month</span>');
    expect(r.body.main).toContain('<a class="btn primary" href="/chief-of-staff/models/setup/tasks" data-next>Next: the model for each task</a>');
    expect(primaries(r.body.main)).toBe(1);
    expect(r.body.main).not.toContain("<!doctype");
  });

  it("sets the suggestion the server works out at the volume posted, whatever else is posted", async () => {
    await postInPlace({ do: "accept", per_day: "10", amount: "", accept: "2" });
    expect(await readBudget(env.DB, ownerId, "openrouter")).toMatchObject({ monthlyUsd: 61, setHow: "accepted" });
  });

  it("names only the day a budget was set, never a provenance the figures beside it could contradict", async () => {
    // Accepted at 10 a day ($61), shown at 5 a day, where the suggestion is $31.
    await postInPlace({ do: "accept", per_day: "10" });
    const html = await page("?per_day=5");
    expect(html).toContain('<span class="num big">$61</span>');
    expect(html).toContain('Suggested: about <span data-sugg>$31</span> a month');
    expect(html).toMatch(/<p class="meta">Set \d{1,2} [A-Z][a-z]{2} \d{4}\.<\/p>/);
    expect(html).not.toContain("from the suggestion");
  });

  it("sets, without the script, by post-redirect-get, the confirmation shown once", async () => {
    const r = await post({ do: "accept", per_day: "5" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`${BASE}?per_day=5`);
    const shown = await send("?per_day=5", { headers: { cookie: flashOf(r) } });
    const html = await shown.text();
    expect(html).toContain("Budget set: $31 a month.");
    expect(shown.headers.get("set-cookie")).toContain("cos_budgets_flash=; Path=/chief-of-staff/models/setup/budgets; Max-Age=0");
    expect(await page("?per_day=5")).not.toContain("Budget set: $31 a month.");
  });

  it("sets and changes the budget the user types, however large", async () => {
    await postInPlace({ do: "set", amount: "12.50", per_day: "5" });
    expect(await readBudget(env.DB, ownerId, "openrouter")).toMatchObject({ monthlyUsd: 12.5, setHow: "typed" });
    const r = await postInPlace({ do: "set", amount: "$25,000", per_day: "5" });
    expect(await readBudget(env.DB, ownerId, "openrouter")).toMatchObject({ monthlyUsd: 25000, setHow: "typed" });
    expect(r.body.main).toContain('value="25000" data-k="amount"');
  });

  it("refuses an amount that is not a budget under its field, keeping what was typed, in place and without the script", async () => {
    await setBudget(env.DB, ownerId, "openrouter", 12, "typed", NOW);
    const r = await postInPlace({ do: "set", amount: "twelve", per_day: "5" });
    expect(r.status).toBe(400);
    expect(r.body.focus).toBe("amount");
    expect(r.body.main).toContain('value="twelve" aria-invalid="true" aria-describedby="amount-err"');
    expect(r.body.main).toContain('<p class="field-err" id="amount-err" role="alert">Type a budget in dollars, more than $0, for example 30.</p>');
    const plain = await post({ do: "set", amount: "0", per_day: "5" });
    expect(plain.status).toBe(303);
    expect(plain.headers.get("location")).toBe(`${BASE}?per_day=5#amount`);
    expect(await (await send("?per_day=5", { headers: { cookie: flashOf(plain) } })).text()).toContain('value="0" aria-invalid="true"');
    expect(await readBudget(env.DB, ownerId, "openrouter")).toMatchObject({ monthlyUsd: 12, setHow: "typed" });
  });

  it("refuses a user who has not connected OpenRouter, and a form posted from another site", async () => {
    const friend = await send("", { method: "POST", body: new URLSearchParams({ do: "set", amount: "10" }), headers: { "content-type": "application/x-www-form-urlencoded" } }, { sub: "friend-sub", email: "friend@example.com" });
    expect(friend.status).toBe(303);
    const back = await send("", { headers: { cookie: friend.headers.get("set-cookie")!.split(";")[0]! } }, { sub: "friend-sub", email: "friend@example.com" });
    expect(await back.text()).toContain('<div class="banner warn" role="alert">Connect OpenRouter first. The budget limits its calls.</div>');
    expect(await readBudget(env.DB, (await userFor("friend-sub")).id, "openrouter")).toBeUndefined();
    const elsewhere = await post({ do: "set", amount: "10" }, { origin: "https://elsewhere.example" });
    expect(elsewhere.status).toBe(403);
    expect(await readBudget(env.DB, ownerId, "openrouter")).toBeUndefined();
  });

  it("keeps each user's budget their own", async () => {
    const friend = (await userFor("friend-sub")).id;
    await writeConnection(env.DB, friend, testPlugin(), { method: "oauth_pkce", key_hash: "c".repeat(64) }, NOW);
    await setBudget(env.DB, friend, "openrouter", 99, "typed", NOW);
    expect(await page()).not.toContain("$99");
    await postInPlace({ do: "set", amount: "10" });
    expect(await readBudget(env.DB, ownerId, "openrouter")).toMatchObject({ monthlyUsd: 10 });
    expect(await readBudget(env.DB, friend, "openrouter")).toMatchObject({ monthlyUsd: 99 });
  });

  it("refuses an Access token that names no person", async () => {
    expect((await send("", {}, { sub: undefined, email: undefined })).status).toBe(403);
  });
});

describe("the page's script", () => {
  // The few elements the script touches, as the server rendered them; the
  // document records the script's listeners so a test can fire an event at
  // an element, as the browser does.
  function stage(html: string) {
    const perApp = html.match(/data-per-day data-per-app="([^"]+)"/)![1]!;
    const field = Object.assign(element({ "data-per-day": "", "data-per-app": perApp }), { value: "5", matches: (s: string) => s === "[data-per-day]" });
    const figures = [element(), element()];
    const accept = Object.assign(element({ "data-label": html.match(/data-accept data-label="([^"]+)"/)![1]! }), { textContent: "" });
    const copies = [element(), element()].map((e) => Object.assign(e, { value: "5" }));
    const all: Record<string, unknown[]> = { "[data-per-day]": [field], "[data-sugg]": figures, "[data-accept]": [accept], "[data-per-day-copy]": copies };
    const main = Object.assign(element({ id: "screen" }), {
      querySelector: (s: string) => all[s]?.[0] ?? null,
      querySelectorAll: (s: string) => all[s] ?? [],
      contains: () => true,
    });
    const listeners: Record<string, Array<(e: unknown) => void>> = {};
    const document = {
      getElementById: (id: string) => (id === "screen" ? main : null),
      querySelectorAll: () => [],
      addEventListener: (type: string, fn: (e: unknown) => void) => void (listeners[type] ??= []).push(fn),
    };
    const fire = (type: string, target: unknown) => listeners[type]?.forEach((fn) => fn({ target, preventDefault: () => {} }));
    return { document, fire, field, figures, accept, copies };
  }

  it("works the suggestion out again as the volume is typed, with the server's own sum, and sends nothing", async () => {
    const html = await page("?per_day=5");
    const s = stage(html);
    const sent: Sent = [];
    runScript(pageScripts(html), s.document, BASE, sent, { window: { fetch: () => {}, addEventListener: () => {} } });
    const basis = (await basisNow())!;
    for (const n of [10, 1, 37, 100]) {
      s.field.value = String(n);
      s.fire("input", s.field);
      const usd = `$${suggest(basis, n).monthlyUsd.toLocaleString("en-US")}`;
      expect(s.figures.map((f) => f.textContent)).toEqual([usd, usd]);
      expect(s.accept.textContent).toBe(`Set ${usd} a month`);
      expect(s.copies.map((c) => c.value)).toEqual([String(n), String(n)]);
      expect(s.field.getAttribute("aria-invalid")).toBe("false");
    }
    // Not a volume: Set is held until it is one, and the last figure stays.
    for (const bad of ["", "0", "101", "2.5"]) {
      s.field.value = bad;
      s.fire("input", s.field);
      expect(s.field.getAttribute("aria-invalid")).toBe("true");
      expect(s.accept.disabled).toBe(true);
    }
    expect(s.copies.map((c) => c.value)).toEqual(["100", "100"]);
    expect(sent).toEqual([]);
  });
});
