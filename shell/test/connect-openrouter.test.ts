// Connect OpenRouter end to end through the Providers routes, with the real
// plug-in against a stand-in OpenRouter (fake-sources.ts): the consent page,
// the code exchange, the key in the vault, the landing with no call made,
// the account line, the account's model list, a model's test call in place
// and without the script, a key removed on OpenRouter, and Disconnect.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAccountList } from "../src/models/account-list";
import { readLatestTests } from "../src/models/latest-tests";
import { refreshPrices } from "../src/prices/refresh";
import { readCurrentCatalog } from "../src/prices/store";
import { providerPlugins } from "../src/providers/index";
import { readCheck } from "../src/providers/check";
import { handleProviders } from "../src/providers/page";
import { PAGE_SCRIPT } from "../src/providers/page-script";
import { sha256Hex } from "../src/providers/openrouter";
import { vaultSecrets } from "../src/providers/secrets";
import { setBudget } from "../src/proxy/budgets";
import { readConnection } from "../src/proxy/connections";
import { fakeFetch, ISSUED_KEY, keyReply, MODELS, type Overrides } from "./fake-sources";
import { dumpEveryTable, userFor, VAULT_KEY } from "./test-plugin";

const NOW = new Date("2026-11-27T10:00:00Z");
const ORIGIN = "https://cos.example.com";
const BASE = `${ORIGIN}/chief-of-staff/models/setup/providers`;
const ENV = { APP_ORIGIN: ORIGIN, VAULT_KEY };

let userId: string;
let fetcher: ReturnType<typeof fakeFetch>;
let cookie = "";

const plugins = async (env_ = ENV) => providerPlugins(env_, vaultSecrets(env.DB, env_), await readCurrentCatalog(env.DB), fetcher);
const handle = async (request: Request, opts: { env?: typeof ENV; viewer?: "owner" | "friend"; now?: Date } = {}) => {
  const e = opts.env ?? ENV;
  const response = await handleProviders(request, {
    db: env.DB,
    plugins: await plugins(e),
    readPlugins: () => plugins(e),
    secrets: vaultSecrets(env.DB, e),
    userId,
    viewer: opts.viewer ?? "owner",
    appOrigin: e.APP_ORIGIN,
    now: opts.now ?? NOW,
    fetcher,
  });
  // The browser keeps the flash cookie for the next page.
  const set = response.headers.get("set-cookie");
  if (set) cookie = set.includes("Max-Age=0") ? "" : set.split(";")[0]!;
  return response;
};
type Opts = Parameters<typeof handle>[1] & { json?: boolean };
const headers = (opts: Opts, extra: Record<string, string> = {}) => ({ ...(opts.json ? { accept: "application/json" } : {}), ...(cookie ? { cookie } : {}), ...extra });
const post = (path: string, fields: Record<string, string> = {}, opts: Opts = {}) =>
  handle(new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers: headers(opts, { origin: ORIGIN }) }), opts);
const get = (path = "", opts: Opts = {}) => handle(new Request(`${BASE}${path}`, { headers: headers(opts) }), opts);
const json = async (r: Response) => (await r.json()) as { main: string; view: string; focus?: string };
// A redirect's address, followed as the browser would.
const follow = async (r: Response, opts: Opts = {}) => {
  expect(r.status).toBe(303);
  return handle(new Request(r.headers.get("location")!, { headers: headers(opts) }), opts);
};

// The text a page shows outside its collapsed <details>, one entry per element's text.
const visibleLines = (html: string): string[] =>
  html
    .replace(/<details[\s\S]*?<\/details>/g, "")
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/g, "")
    .split(/<[^>]+>/)
    .map((t) => t.replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim())
    .filter(Boolean);
// Every solid app-blue button: the one next step.
const primaries = (html: string): string[] => [...html.matchAll(/class="btn(?: wide)? primary[^"]*"[^>]*>([^<]*)/g)].map((m) => m[1]!.trim());
const rowOf = (html: string, model: string) => html.match(new RegExp(`<li class="row"[^>]*data-id="${model.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"[\\s\\S]*?</li>`))![0];

// Connect, then come back from OpenRouter's page as it would send the user.
async function connect(overrides: Overrides = {}): Promise<Response> {
  fetcher = fakeFetch(overrides);
  const start = await post("/openrouter/connect");
  expect(start.status).toBe(303);
  const auth = new URL(start.headers.get("location")!);
  const callback = new URL(auth.searchParams.get("callback_url")!);
  return get(`${callback.pathname.replace("/chief-of-staff/models/setup/providers", "")}?code=code-1&state=${auth.searchParams.get("state")}`);
}

beforeEach(async () => {
  cookie = "";
  fetcher = fakeFetch();
  await refreshPrices({ db: env.DB, fetcher, now: new Date("2026-11-27T06:00:00Z") });
  userId = (await userFor("owner-sub")).id;
});
afterEach(() => vi.restoreAllMocks());

describe("Connect OpenRouter", () => {
  it("has no field to fill: one button leads to OpenRouter's own page, with the budget as the key's credit limit", async () => {
    const html = await (await get()).text();
    expect(html).toContain("Connect OpenRouter");
    expect(primaries(html)).toEqual(["Connect OpenRouter"]);
    expect(html).not.toMatch(/Bedrock|Foundry|Vertex/);
    expect(html).not.toContain('id="test"');
    await setBudget(env.DB, userId, "openrouter", 25, "typed", NOW);
    const start = await post("/openrouter/connect");
    const auth = new URL(start.headers.get("location")!);
    expect(auth.origin).toBe("https://openrouter.ai");
    expect(auth.searchParams.get("callback_url")).toBe(`${BASE}/openrouter/consented`);
    expect(auth.searchParams.get("limit")).toBe("25.00");
    // The verifier waits in the vault, never in the check row or the URL.
    const check = await readCheck(env.DB, userId, "openrouter");
    expect(check?.consentState).toBe(auth.searchParams.get("state"));
    // Each key's label names when Connect was tapped.
    expect(auth.searchParams.get("key_label")).toBe("Chief of staff · 2026-11-27 10:00:00 UTC");
    const { results } = await env.DB.prepare("SELECT name FROM vault_items WHERE user_id = ?").bind(userId).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["provider-verifier:openrouter"]);
  });

  it("prefills $10 before any budget is set", async () => {
    const auth = new URL((await post("/openrouter/connect")).headers.get("location")!);
    expect(auth.searchParams.get("limit")).toBe("10.00");
  });

  it("puts the issued key in the vault, sealed, and never anywhere else; makes no call, and lands with the search field focused once", async () => {
    const logged: string[] = [];
    for (const level of ["log", "warn", "error", "info"] as const) vi.spyOn(console, level).mockImplementation((...a) => void logged.push(a.join(" ")));
    const back = await connect();
    expect(back.status).toBe(303);
    // To the page itself, no anchor: the landing is a one-time flash.
    expect(back.headers.get("location")).toBe(`${BASE}?provider=openrouter`);
    expect(await readConnection(env.DB, userId, "openrouter")).toEqual({ method: "oauth_pkce", key_hash: await sha256Hex(ISSUED_KEY) });
    const check = await readCheck(env.DB, userId, "openrouter");
    expect(check).toMatchObject({ state: "passed", passedAt: NOW.toISOString() });
    expect(check?.consentState).toBeUndefined();
    // No model call ran by itself; nothing is in the ledger.
    expect(fetcher.sent.filter((s) => s.url.endsWith("/chat/completions"))).toEqual([]);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM model_calls").first<{ n: number }>())!.n).toBe(0);
    expect(JSON.stringify(await dumpEveryTable())).not.toContain(ISSUED_KEY);
    expect(logged.join("\n")).not.toContain(ISSUED_KEY);
    const landing = await follow(back);
    const page = await landing.text();
    expect(page).not.toContain(ISSUED_KEY);
    expect(page).toContain('<main class="screen" id="screen" data-view="provider=openrouter" data-land>');
    expect(page).toContain("Connected just now. Ready models need no test. Tasks choose among them.");
    expect(page).toContain("Connected · key in your vault");
    expect(page).toContain('<input type="search" id="pick-q"');
    // The flash is spent: a refresh lands nowhere and focuses nothing.
    const again = await (await get("?provider=openrouter")).text();
    expect(again).toContain('<main class="screen" id="screen" data-view="provider=openrouter">');
    expect(again).not.toContain("Connected just now");
  });

  it("lists every model from OpenRouter's own list, nothing else, with prices, strength and Free", async () => {
    await connect();
    const html = await (await get()).text();
    const ids = [...html.matchAll(/<li class="row"[^>]*data-id="([^"]+)"/g)].map((m) => m[1]);
    // Every one but those OpenRouter lists with no tool use.
    const listed = (await readCurrentCatalog(env.DB))!.models.filter((m) => m.blocked || m.tools).map((m) => m.id);
    expect(ids).toEqual(listed);
    expect(listed.length).toBeLessThan((await readCurrentCatalog(env.DB))!.models.length);
    expect(ids).not.toContain("~openai/gpt-luna-latest");
    expect(ids).not.toContain("openai/gpt-oss-20b:batch");
    const luna = rowOf(html, "openai/gpt-6-luna");
    expect(luna).toContain('<span class="price num">$0.10 / $0.50</span>');
    expect(luna).toContain('<span class="tier">Smallest</span>');
    const free = MODELS.data.find((m) => m.id.endsWith(":free"))!.id;
    expect(rowOf(html, free)).toContain('<span class="pill free">Free</span>');
    expect(luna).not.toContain("pill free");
    expect(html).toContain("Every model OpenRouter lists is here but the ones no task can use: 1 “:batch” variant (they answer no chat call)");
    expect(html).toMatch(/It also leaves out \d+ models? that lists? no tool use: a task's agent calls tools\./);
  });

  it("shows the OpenRouter account line, read live with the key from the vault", async () => {
    await connect({ currentKey: (s) => (s.headers.authorization === `Bearer ${ISSUED_KEY}` ? keyReply({ is_free_tier: true, limit: 10, limit_remaining: 10, usage: 0, workspace_id: "ws-1" }) : new Response(null, { status: 401 })) });
    const page = await (await get()).text();
    expect(page).toContain("<strong>Account:</strong> never bought credits · personal key · key limit $10.00, $10.00 left · key spent $0");
    expect(page).toContain('href="https://openrouter.ai/settings/credits"');
    fetcher = fakeFetch({ currentKey: () => new Response("down", { status: 503 }) });
    expect(await (await get()).text()).toContain("could not be read just now.");
  });

  it("tests a model in place: one call, a JSON answer with the result under its row, and no redirect", async () => {
    await connect();
    // The landing visit reads the account line once.
    await get();
    fetcher = fakeFetch();
    const tested = await post("/openrouter/test", { model: "openai/gpt-6-luna" }, { json: true });
    expect(tested.status).toBe(200);
    expect(tested.headers.get("location")).toBeNull();
    const body = await json(tested);
    expect(body.view).toBe("provider=openrouter&result=openai%2Fgpt-6-luna");
    expect(body.focus).toBe("t-openai/gpt-6-luna");
    const row = rowOf(body.main, "openai/gpt-6-luna");
    expect(row).toContain("<strong>GPT-6 Luna passed.</strong> It answered just now.");
    // A Ready row carries no tag; the strip's Ready cell finds it.
    expect(row).toContain('data-state="ready"');
    expect(row).not.toMatch(/class="pill[^"]*">(Works|Ready)/);
    // The card is left as the page has it: the account is not read again.
    expect(body.main).toContain('data-part="provider" data-keep');
    expect(fetcher.sent.map((s) => new URL(s.url).pathname)).toEqual(["/api/v1/chat/completions"]);
    expect(fetcher.sent[0]!.headers.authorization).toBe(`Bearer ${ISSUED_KEY}`);
    // The ledger has the test call at OpenRouter's reported cost and its generation ID.
    const row_ = await env.DB.prepare("SELECT task, cost_source, provider_call_id, cost_usd FROM model_calls WHERE user_id = ?").bind(userId).first();
    expect(row_).toEqual({ task: "test_call", cost_source: "reported", provider_call_id: "gen-test-0001", cost_usd: 0.0000022 });
    expect((await readLatestTests(env.DB, userId, "openrouter")).get("openai/gpt-6-luna")?.state).toBe("passed");
    // A second test keeps the first result under its row.
    const second = await handle(new Request(`${BASE}/openrouter/test`, { method: "POST", body: new URLSearchParams({ model: "mistralai/mistral-nemo" }), headers: { origin: ORIGIN, accept: "application/json", "x-cos-view": body.view } }));
    const both = await json(second);
    expect(both.view).toBe("provider=openrouter&result=mistralai%2Fmistral-nemo&result=openai%2Fgpt-6-luna");
    expect(rowOf(both.main, "openai/gpt-6-luna")).toContain("passed.</strong> It answered just now.");
    expect(rowOf(both.main, "mistralai/mistral-nemo")).toContain("passed.</strong> It answered just now.");
    fetcher = fakeFetch();
    // Asking for the same view again runs nothing.
    fetcher = fakeFetch();
    await get(`?${body.view}`, { json: true });
    await get(`?${body.view}`);
    expect(fetcher.sent.filter((s) => s.url.endsWith("/chat/completions"))).toEqual([]);
  });

  it("without the script, a test posts and redirects to its result, so a refresh runs nothing", async () => {
    await connect();
    fetcher = fakeFetch({ chat: () => Response.json({ error: { code: 404, message: "No endpoints found" } }, { status: 404 }) });
    const tested = await post("/openrouter/test", { model: "openai/gpt-6-luna" });
    expect(tested.status).toBe(303);
    expect(tested.headers.get("location")).toBe(`${BASE}?provider=openrouter&result=openai%2Fgpt-6-luna#m-openai-gpt-6-luna`);
    fetcher = fakeFetch();
    const page = await (await follow(tested)).text();
    expect(fetcher.sent.filter((s) => s.url.endsWith("/chat/completions"))).toEqual([]);
    const row = rowOf(page, "openai/gpt-6-luna");
    expect(row).toContain('data-state="ready"');
    expect(row).toContain("<strong>Failed when tested · ");
    expect(row).toContain('<span class="lbl">Try again</span>');
    expect(row).toContain("OpenRouter replied: 404");
    expect((await readLatestTests(env.DB, userId, "openrouter")).get("openai/gpt-6-luna")?.state).toBe("failed");
  });

  it("keeps a model Ready when a single Test is refused as busy, and carries the result in the view", async () => {
    await connect();
    fetcher = fakeFetch();
    await post("/openrouter/test", { model: "openai/gpt-6-luna" }, { json: true });
    const passed = (await readLatestTests(env.DB, userId, "openrouter")).get("openai/gpt-6-luna");
    expect(passed?.state).toBe("passed");
    fetcher = fakeFetch({ chat: () => Response.json({ error: { code: 429, message: "Rate limited upstream" } }, { status: 429 }) });
    const tested = await post("/openrouter/test", { model: "openai/gpt-6-luna" }, { now: new Date("2026-11-27T10:05:00Z") });
    expect(tested.status).toBe(303);
    const [model, reason, reply] = new URL(tested.headers.get("location")!).searchParams.get("result")!.split("|");
    expect([model, reason]).toEqual(["openai/gpt-6-luna", "busy"]);
    expect(JSON.parse(reply!)).toMatchObject({ status: 429, message: "Rate limited upstream" });
    fetcher = fakeFetch();
    const page = await (await follow(tested)).text();
    expect(fetcher.sent.filter((s) => s.url.endsWith("/chat/completions"))).toEqual([]);
    const row = rowOf(page, "openai/gpt-6-luna");
    expect(row).toContain('data-state="ready"');
    expect(row).toContain("Test again");
    expect(row).toContain("OpenRouter replied: 429");
    expect(row).toContain("Rate limited upstream");
    expect((await readLatestTests(env.DB, userId, "openrouter")).get("openai/gpt-6-luna")).toEqual(passed);
  });

  it("names the tasks that fall to their fallback when a model fails, or that have none", async () => {
    await connect();
    fetcher = fakeFetch();
    await post("/openrouter/test", { model: "openai/gpt-6-luna" }, { json: true });
    await post("/openrouter/test", { model: "mistralai/mistral-nemo" }, { json: true });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO task_routes (user_id, task, main_provider, main_model, set_how, set_at) VALUES (?, 'match', 'openrouter', 'openai/gpt-6-luna', 'changed', ?)").bind(userId, NOW.toISOString()),
      env.DB.prepare("INSERT INTO task_routes (user_id, task, main_provider, main_model, fallback_provider, fallback_model, set_how, set_at) VALUES (?, 'score', 'openrouter', 'openai/gpt-6-luna', 'openrouter', 'mistralai/mistral-nemo', 'changed', ?)").bind(userId, NOW.toISOString()),
    ]);
    fetcher = fakeFetch({ chat: () => Response.json({ error: { code: 404, message: "No endpoints found" } }, { status: 404 }) });
    const { main } = await json(await post("/openrouter/test", { model: "openai/gpt-6-luna" }, { json: true, now: new Date("2026-11-27T10:05:00Z") }));
    const row = rowOf(main, "openai/gpt-6-luna");
    expect(row).toContain("<p>Scoring roles falls to Mistral: Mistral Nemo when it fails.</p>");
    expect(row).toContain("<p>Matching questions has no fallback.</p>");
  });

  it("reads the account's own model list after Connect; a model it leaves out links the settings, then Check again", async () => {
    await connect();
    const list = await readAccountList(env.DB, userId, "openrouter");
    expect(list?.models.has("openai/gpt-6-luna")).toBe(true);
    expect(list?.models.has("anthropic/claude-sonnet-5.5")).toBe(false);
    const html = await (await get()).text();
    const row = rowOf(html, "anthropic/claude-sonnet-5.5");
    expect(row).toContain("Your OpenRouter settings leave it out");
    expect(row).toContain('href="https://openrouter.ai/settings/privacy" target="_blank" rel="noopener noreferrer" data-allow="anthropic/claude-sonnet-5.5"');
    expect(row).toMatch(/<form method="post" action="[^"]+\/check-account" data-fetch class="inline" data-check-for="anthropic\/claude-sonnet-5.5" hidden>/);
    expect(row).toMatch(/aria-label="Test Claude Sonnet 5.5" disabled/);
    // Still left out.
    let checked = await json(await post("/openrouter/check-account", { model: "anthropic/claude-sonnet-5.5" }, { json: true }));
    expect(rowOf(checked.main, "anthropic/claude-sonnet-5.5")).toContain("Your OpenRouter settings still leave it out.");
    expect(checked.focus).toBe("ac-anthropic/claude-sonnet-5.5");
    // Allowed on OpenRouter since.
    fetcher = fakeFetch({ userModels: () => Response.json({ data: MODELS.data }) });
    checked = await json(await post("/openrouter/check-account", { model: "anthropic/claude-sonnet-5.5" }, { json: true }));
    const now = rowOf(checked.main, "anthropic/claude-sonnet-5.5");
    expect(now).toContain("Now allowed for your account. It&#39;s ready for tasks.");
    expect(now).not.toContain("data-blocked");
    expect(checked.focus).toBe("t-anthropic/claude-sonnet-5.5");
  });

  it("gives a router a labelled Set price cap, takes the cap in place, and tests it under the cap", async () => {
    await connect();
    const page = await (await get()).text();
    const auto = rowOf(page, "openrouter/auto");
    expect(auto).toContain("<span>Set price cap</span>");
    expect(auto).toContain("Priced per call by the model it picks");
    const editor = await json(await get("?provider=openrouter&cap=openrouter%2Fauto", { json: true }));
    expect(rowOf(editor.main, "openrouter/auto")).toContain("Cap what one call may cost.");
    expect(primaries(editor.main)).toEqual(["Use this cap"]);
    const bad = await json(await post("/openrouter/cap", { model: "openrouter/auto", input: "0", output: "15" }, { json: true }));
    expect(rowOf(bad.main, "openrouter/auto")).toContain("Enter two prices above $0, each at most $1000.");
    const capped = await json(await post("/openrouter/cap", { model: "openrouter/auto", input: "3", output: "15" }, { json: true }));
    const row = rowOf(capped.main, "openrouter/auto");
    expect(row).toContain("Capped at $3.00 / $15.00 per M tokens. It&#39;s ready for tasks.");
    expect(row).toContain('<span class="price num" title="Price cap">≤ $3.00 / $15.00</span>');
    expect(capped.focus).toBe("t-openrouter/auto");
    fetcher = fakeFetch({ chat: () => Response.json({ id: "gen-r", model: "mistralai/mistral-nemo", choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 9, completion_tokens: 1, cost: 0.0000004 } }) });
    const tested = await json(await post("/openrouter/test", { model: "openrouter/auto" }, { json: true }));
    expect(rowOf(tested.main, "openrouter/auto")).toContain("passed.</strong> It answered just now.");
    const sent = fetcher.sent.find((s) => s.url.endsWith("/chat/completions"))!.body as Record<string, unknown>;
    expect(sent.provider).toEqual({ max_price: { prompt: "3", completion: "15", request: "0", image: "0", audio: "0" } });
    expect(sent.plugins).toEqual([{ id: "auto-router", excluded_models: (await readCurrentCatalog(env.DB))!.feeModels }]);
  });

  it("keeps exactly one solid blue button, the next step, in every state", async () => {
    await connect();
    // Connected on a fresh list: nothing to test first, so Next: budgets.
    let html = await (await get()).text();
    expect(primaries(html)).toEqual(["Next: budgets"]);
    for (const gone of ["Test all", "Retest", "Run the test"]) expect(html).not.toContain(gone);
    // The cap editor: Use this cap.
    html = (await json(await get("?provider=openrouter&cap=openrouter%2Fauto", { json: true }))).main;
    expect(primaries(html)).toEqual(["Use this cap"]);
    // A list from before the current rules: Refresh model list.
    await env.DB.prepare("UPDATE openrouter_catalogs SET catalog = json_set(catalog, '$.version', 2)").run();
    html = await (await get()).text();
    expect(primaries(html)).toEqual(["Refresh model list"]);
    expect(html).toContain("This list follows older rules. Read OpenRouter's list again.");
    // The old Test all addresses are gone.
    expect((await post("/openrouter/test-all", {}, { json: true })).status).toBe(405);
  });

  it("makes paid models Ready once credit is added on OpenRouter, on the next visit, with no click and no call", async () => {
    const noCredit = () => keyReply({ is_free_tier: true });
    await connect({ currentKey: noCredit });
    const states = (html: string) => Object.fromEntries([...html.matchAll(/<li class="row"[^>]*data-id="([^"]+)"[^>]*data-state="([a-z]+)"/g)].map((m) => [m[1], m[2]]));
    const free = MODELS.data.find((m) => m.id.endsWith(":free"))!.id;
    const before = await (await get()).text();
    expect(states(before)["openai/gpt-6-luna"]).toBe("credit");
    expect(states(before)[free]).toBe("ready");
    expect(rowOf(before, "openai/gpt-6-luna")).toContain('<span class="pill warn">Needs credit</span>');
    expect(before).toMatch(/data-credit-act>Add credits<\/a>/);
    // Credit is added on OpenRouter; the next visit reads the account line again.
    fetcher = fakeFetch();
    const after = await (await get()).text();
    expect(states(after)["openai/gpt-6-luna"]).toBe("ready");
    expect(after).toMatch(/data-credit-act hidden>Add credits<\/a>/);
    expect(fetcher.sent.filter((s) => s.url.endsWith("/chat/completions"))).toEqual([]);
  });

  it("gives the list's count and the strip's total the same number", async () => {
    await connect();
    const html = await (await get()).text();
    const count = Number(html.match(/<p class="count" id="pick-count" aria-live="polite"><span class="num">(\d+)<\/span> models<\/p>/)![1]);
    const ends = Number(html.match(/<span data-ends>(\d+) models<\/span>/)![1]);
    const cells = ["ready", "credit", "step"].map((k) => Number(html.match(new RegExp(`data-filter="${k}"[\\s\\S]*?<span class="v num[^"]*">(\\d+)</span>`))![1]));
    expect(ends).toBe(count);
    expect(cells.reduce((a, b) => a + b, 0)).toBe(count);
    expect(count).toBe([...html.matchAll(/<li class="row"/g)].length);
    // The router with no cap and the model the account leaves out are counted, in Needs a step.
    expect(cells[2]).toBeGreaterThanOrEqual(2);
  });

  it("says the app's own side is not set up without the vault key, and stores nothing", async () => {
    const response = await post("/openrouter/connect", {}, { env: { APP_ORIGIN: ORIGIN, VAULT_KEY: "" } });
    expect(response.status).toBe(303);
    const page = await (await follow(response, { env: { APP_ORIGIN: ORIGIN, VAULT_KEY: "" } })).text();
    expect(page).toContain("missing VAULT_KEY");
    // Shown once.
    expect(await (await get("", { env: { APP_ORIGIN: ORIGIN, VAULT_KEY: "" } })).text()).not.toContain("missing VAULT_KEY");
  });

  it("refuses an answer with another state, or one used twice", async () => {
    fetcher = fakeFetch();
    const auth = new URL((await post("/openrouter/connect")).headers.get("location")!);
    expect((await get(`/openrouter/consented?code=c&state=forged`)).status).toBe(400);
    expect(await readConnection(env.DB, userId, "openrouter")).toBeUndefined();
    const state = auth.searchParams.get("state");
    // A forged answer spent nothing; the real one works once.
    expect((await get(`/openrouter/consented?code=c&state=${state}`)).status).toBe(303);
    expect((await get(`/openrouter/consented?code=c&state=${state}`)).status).toBe(400);
  });

  it("says plainly when OpenRouter refuses the code, and keeps no key", async () => {
    const back = await connect({ keys: () => Response.json({ error: { code: 403, message: "Authorization code expired" } }, { status: 403 }) });
    expect(back.status).toBe(400);
    expect(await back.text()).toContain("OpenRouter did not accept that authorization (403 Authorization code expired)");
    expect(await readConnection(env.DB, userId, "openrouter")).toBeUndefined();
    expect((await env.DB.prepare("SELECT count(*) AS n FROM vault_items").first<{ n: number }>())!.n).toBe(0);
  });

  it("shows a key deleted on OpenRouter as removed, with Connect OpenRouter again", async () => {
    await connect();
    fetcher = fakeFetch({ chat: () => Response.json({ error: { code: 401, message: "User not found." } }, { status: 401 }) });
    await post("/openrouter/test", { model: "openai/gpt-6-luna" });
    expect(await readCheck(env.DB, userId, "openrouter")).toMatchObject({ state: "revoked", revokedAt: NOW.toISOString() });
    const html = await (await get()).text();
    expect(html).toContain("Removed on OpenRouter's side");
    expect(html).toContain('action="/chief-of-staff/models/setup/providers/openrouter/connect"');
    expect(primaries(html)).toEqual(["Connect OpenRouter"]);
    expect(html).not.toContain('id="test"');
    // Connecting again makes it connected.
    await connect();
    expect(await readCheck(env.DB, userId, "openrouter")).toMatchObject({ state: "passed" });
  });

  it("shows a connection from before 2026-11-27 with no passed test as removed after a 401 test call", async () => {
    await connect();
    // As stored by the old Connect, whose own test call failed: no passed_at.
    await env.DB.prepare("UPDATE provider_checks SET state = 'failed', passed_at = NULL WHERE user_id = ?").bind(userId).run();
    expect(await (await get()).text()).toContain("Connected · key in your vault");
    fetcher = fakeFetch({ chat: () => Response.json({ error: { code: 401, message: "User not found." } }, { status: 401 }) });
    await post("/openrouter/test", { model: "openai/gpt-6-luna" });
    expect(await readCheck(env.DB, userId, "openrouter")).toMatchObject({ state: "revoked", revokedAt: NOW.toISOString() });
    expect(await (await get()).text()).toContain("Removed on OpenRouter's side");
  });

  it("Disconnect asks in place, deletes the key from the vault, the record and the check, and opens that exact key's page on OpenRouter", async () => {
    await connect();
    const hash = await sha256Hex(ISSUED_KEY);
    const keyPage = `https://openrouter.ai/keys/${hash}`;
    const confirm = (await json(await get("?provider=openrouter&confirm=disconnect", { json: true }))).main;
    const card = confirm.match(/<div class="panel provider" data-part="provider">[\s\S]*?<\/section>/)![0];
    expect(card).toContain("<strong>Disconnect OpenRouter?</strong> The app deletes the key from your vault, and its models stop answering for you at once.");
    expect(card).toContain(`<a class="ext" href="${keyPage}" target="_blank" rel="noopener noreferrer">Open its page</a>`);
    expect(card).toContain("OpenRouter&#39;s delete-a-key API takes only your own management key");
    expect(card).toMatch(/<button type="submit" class="btn small danger-o" data-k="disc-yes">Disconnect<\/button>/);
    expect(confirm).not.toContain(ISSUED_KEY);
    const gone = await post("/openrouter/disconnect");
    expect(gone.status).toBe(303);
    expect(gone.headers.get("location")).toBe(`${BASE}?provider=openrouter&disconnected=1`);
    const after = await (await follow(gone)).text();
    const box = after.match(/<div class="panel provider" data-part="provider">[\s\S]*?<\/div><\/div>/)![0];
    expect(visibleLines(box)).toEqual(["OpenRouter", "Not connected", "Disconnected.", "The key stays valid on OpenRouter until you delete it there.", "Your keys on OpenRouter", "Connect OpenRouter"]);
    expect(box).toContain('href="https://openrouter.ai/settings/keys"');
    expect(after).not.toContain(ISSUED_KEY);
    expect(await readConnection(env.DB, userId, "openrouter")).toBeUndefined();
    expect(await readCheck(env.DB, userId, "openrouter")).toBeUndefined();
    expect(await readAccountList(env.DB, userId, "openrouter")).toBeUndefined();
    expect((await env.DB.prepare("SELECT count(*) AS n FROM vault_items").first<{ n: number }>())!.n).toBe(0);
  });

  it("disconnects in place too: the answer is the page with Connect, no redirect", async () => {
    await connect();
    const gone = await post("/openrouter/disconnect", {}, { json: true });
    expect(gone.status).toBe(200);
    const body = await json(gone);
    expect(body.view).toBe("provider=openrouter&disconnected=1");
    expect(body.focus).toBe("connect");
    expect(primaries(body.main)).toEqual(["Connect OpenRouter"]);
    expect(body.main).not.toContain('id="test"');
  });

  it("never shows any part of the issued key: connected, at Disconnect's confirmation, or after it", async () => {
    // GET /api/v1/key can label the key with its masked form.
    const masked = `${ISSUED_KEY.slice(0, 12)}...${ISSUED_KEY.slice(-4)}`;
    await connect({ currentKey: () => keyReply({ label: masked }) });
    const pages = [await (await get("?provider=openrouter")).text(), await (await get("?provider=openrouter&confirm=disconnect")).text()];
    const gone = await post("/openrouter/disconnect");
    pages.push(await (await follow(gone)).text());
    for (const html of pages) {
      for (const part of [ISSUED_KEY, ISSUED_KEY.slice(0, 12), ISSUED_KEY.slice(-4), masked]) expect(html).not.toContain(part);
    }
  });

  it("Connect again mints a new key with a new dated label, and says why under Connect", async () => {
    const before = await (await get()).text();
    expect(before).toContain("OpenRouter&#39;s flow has no way to reuse one");
    await connect();
    await post("/openrouter/disconnect");
    fetcher = fakeFetch();
    const later = new Date("2026-11-28T09:30:00Z");
    const start = await post("/openrouter/connect", {}, { now: later });
    const auth = new URL(start.headers.get("location")!);
    expect(auth.searchParams.get("key_label")).toBe("Chief of staff · 2026-11-28 09:30:00 UTC");
    const back = await get(`/openrouter/consented?code=code-2&state=${auth.searchParams.get("state")}`, { now: later });
    expect(back.status).toBe(303);
    expect(await readConnection(env.DB, userId, "openrouter")).toEqual({ method: "oauth_pkce", key_hash: await sha256Hex(ISSUED_KEY) });
  });

  it("Refresh model list reads OpenRouter's list and the account's again, at most once a minute", async () => {
    await connect();
    await get();
    const later = new Date("2026-11-27T10:05:00Z");
    fetcher = fakeFetch();
    const refreshed = await post("/openrouter/refresh", {}, { now: later, json: true });
    expect(refreshed.status).toBe(200);
    expect(fetcher.sent.map((s) => new URL(s.url).pathname)).toEqual(["/api/v1/models", "/api/v1/models/user"]);
    const again = await json(await post("/openrouter/refresh", {}, { now: new Date("2026-11-27T10:05:30Z"), json: true }));
    expect(again.main).toContain("Refresh it again from 10:06 UTC");
    // Without the script, the same problem shows once after the redirect.
    const plain = await post("/openrouter/refresh", {}, { now: new Date("2026-11-27T10:05:40Z") });
    expect(plain.status).toBe(303);
    expect(await (await follow(plain)).text()).toContain("Refresh it again from 10:06 UTC");
  });

  it("says in one short line when the account's own list could not be read, with OpenRouter's reply in Details", async () => {
    await connect();
    fetcher = fakeFetch({ userModels: () => Response.json({ error: { code: 503, message: "upstream down" } }, { status: 503 }) });
    const { main } = await json(await post("/openrouter/refresh", {}, { now: new Date("2026-11-27T10:05:00Z"), json: true }));
    const err = main.match(/<div class="err" role="alert">[\s\S]*?<\/details><\/div><\/div>/)![0];
    expect(visibleLines(err)).toEqual(["Showing OpenRouter's public list."]);
    expect(err).toContain("did not give your account&#39;s model list (503");
  });

  it("sends Admin a friend's failed model with its plain line and its fix, never the provider's reply", async () => {
    await connect();
    const asked = await post("/openrouter/model-help", { model: "openai/gpt-6-luna", reason: "budget_spent" }, { viewer: "friend" });
    expect(asked.status).toBe(303);
    expect(await (await follow(asked, { viewer: "friend" })).text()).toContain("Sent to Admin: this item&#39;s name and its plain reason only.");
    const row = await env.DB.prepare("SELECT item, reason FROM help_requests WHERE user_id = ?").bind(userId).first<{ item: string; reason: string }>();
    expect(row).toEqual({
      item: "Test a model: openai/gpt-6-luna",
      reason: "This month's budget is spent. The test call waits until the 1st. Raise the budget on Budgets, then test openai/gpt-6-luna again.",
    });
  });

  it("refuses a form from another site, and a provider that does not exist", async () => {
    const forged = await handle(new Request(`${BASE}/openrouter/connect`, { method: "POST", body: new URLSearchParams(), headers: { origin: "https://elsewhere.example" } }));
    expect(forged.status).toBe(403);
    expect((await post("/bedrock/connect")).status).toBe(404);
  });
});

describe("the page's script", () => {
  it("parses, and never reloads the page or changes its address", () => {
    expect(() => new Function(PAGE_SCRIPT)).not.toThrow();
    for (const banned of ["location.reload", "location.assign", "location.replace", "location.href =", "pushState", "replaceState", "window.location ="]) {
      expect(PAGE_SCRIPT, banned).not.toContain(banned);
    }
    // It asks for JSON, and polls for nothing: no run goes on in the background.
    expect(PAGE_SCRIPT).toContain('accept: "application/json"');
    expect(PAGE_SCRIPT).not.toContain("setTimeout(function () {\n      if (S.busy");
    expect(PAGE_SCRIPT).not.toContain("x-cos-poll");
  });
});
