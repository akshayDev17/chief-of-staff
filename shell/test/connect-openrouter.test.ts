// Connect OpenRouter end to end through the Providers routes, with the real
// plug-in against a stand-in OpenRouter (fake-sources.ts): the consent page,
// the code exchange, the key in the vault, the landing on the model test with
// no call made, the account line, the account's model list, a chosen model's
// test call, a key removed on OpenRouter, and Disconnect.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAccountList } from "../src/models/account-list";
import { refreshPrices } from "../src/prices/refresh";
import { readCurrentCatalog } from "../src/prices/store";
import { providerPlugins } from "../src/providers/index";
import { readCheck } from "../src/providers/check";
import { handleProviders } from "../src/providers/page";
import { sha256Hex } from "../src/providers/openrouter";
import { vaultSecrets } from "../src/providers/secrets";
import { setBudget } from "../src/proxy/budgets";
import { readConnection } from "../src/proxy/connections";
import { fakeFetch, ISSUED_KEY, keyReply, type Overrides } from "./fake-sources";
import { listboxPage, pageScripts } from "./script-dom";
import { dumpEveryTable, userFor, VAULT_KEY } from "./test-plugin";

const NOW = new Date("2026-11-27T10:00:00Z");
const ORIGIN = "https://cos.example.com";
const BASE = `${ORIGIN}/chief-of-staff/models/setup/providers`;
const ENV = { APP_ORIGIN: ORIGIN, VAULT_KEY };

let userId: string;
let fetcher: ReturnType<typeof fakeFetch>;

const plugins = async (env_ = ENV) => providerPlugins(env_, vaultSecrets(env.DB, env_), await readCurrentCatalog(env.DB), fetcher);
const handle = async (request: Request, opts: { env?: typeof ENV; viewer?: "owner" | "friend"; now?: Date } = {}) => {
  const e = opts.env ?? ENV;
  return handleProviders(request, {
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
};
const post = (path: string, fields: Record<string, string> = {}, opts: Parameters<typeof handle>[1] = {}) =>
  handle(new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers: { origin: ORIGIN } }), opts);
const get = (path = "", opts: Parameters<typeof handle>[1] = {}) => handle(new Request(`${BASE}${path}`), opts);

// The text a page shows outside its collapsed <details>, one entry per element's text.
const visibleLines = (html: string): string[] =>
  html
    .replace(/<details[\s\S]*?<\/details>/g, "")
    .split(/<[^>]+>/)
    .map((t) => t.replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim())
    .filter(Boolean);
const words = (line: string): number => line.split(" ").length;

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
  fetcher = fakeFetch();
  await refreshPrices({ db: env.DB, fetcher, now: new Date("2026-11-27T06:00:00Z") });
  userId = (await userFor("owner-sub")).id;
});
afterEach(() => vi.restoreAllMocks());

describe("Connect OpenRouter", () => {
  it("has no field to fill: one button leads to OpenRouter's own page, with the budget as the key's credit limit", async () => {
    const html = await (await get()).text();
    expect(html).toContain("Connect OpenRouter");
    expect(html).not.toMatch(/<input class="f/);
    expect(html).not.toMatch(/Bedrock|Foundry|Vertex/);
    await setBudget(env.DB, userId, "openrouter", 25, "typed", NOW);
    const start = await post("/openrouter/connect");
    const auth = new URL(start.headers.get("location")!);
    expect(auth.origin).toBe("https://openrouter.ai");
    expect(auth.searchParams.get("callback_url")).toBe(`${BASE}/openrouter/consented`);
    expect(auth.searchParams.get("limit")).toBe("25.00");
    // The verifier waits in the vault, never in the check row or the URL.
    const check = await readCheck(env.DB, userId, "openrouter");
    expect(check?.consentState).toBe(auth.searchParams.get("state"));
    // The dated label waits with the consent, until OpenRouter sends the user back.
    expect(auth.searchParams.get("key_label")).toBe("Chief of staff · 2026-11-27 10:00 UTC");
    expect(check?.pendingFields).toEqual({ key_label: "Chief of staff · 2026-11-27 10:00 UTC" });
    const { results } = await env.DB.prepare("SELECT name FROM vault_items WHERE user_id = ?").bind(userId).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["provider-verifier:openrouter"]);
  });

  it("prefills $10 before any budget is set", async () => {
    const auth = new URL((await post("/openrouter/connect")).headers.get("location")!);
    expect(auth.searchParams.get("limit")).toBe("10.00");
  });

  it("puts the issued key in the vault, sealed, and never anywhere else; makes no call, and lands on the model test", async () => {
    const logged: string[] = [];
    for (const level of ["log", "warn", "error", "info"] as const) vi.spyOn(console, level).mockImplementation((...a) => void logged.push(a.join(" ")));
    const back = await connect();
    expect(back.status).toBe(303);
    // Straight to the model test, highlighted by its anchor.
    expect(back.headers.get("location")).toBe(`${BASE}?provider=openrouter#test`);
    expect(await readConnection(env.DB, userId, "openrouter")).toEqual({ method: "oauth_pkce", key_hash: await sha256Hex(ISSUED_KEY), key_label: "Chief of staff · 2026-11-27 10:00 UTC" });
    const check = await readCheck(env.DB, userId, "openrouter");
    expect(check).toMatchObject({ state: "passed", passedAt: NOW.toISOString() });
    expect(check?.consentState).toBeUndefined();
    // No model call ran by itself; nothing is in the ledger.
    expect(fetcher.sent.filter((s) => s.url.endsWith("/chat/completions"))).toEqual([]);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM model_calls").first<{ n: number }>())!.n).toBe(0);
    const stored = JSON.stringify(await dumpEveryTable());
    expect(stored).not.toContain(ISSUED_KEY);
    expect(logged.join("\n")).not.toContain(ISSUED_KEY);
    const page = await (await get()).text();
    expect(page).not.toContain(ISSUED_KEY);
    expect(page).toContain("<strong>Connected</strong>");
    expect(page).toContain("key in your vault");
    expect(page).toContain("<strong>Not usable yet:</strong> test a model below.");
    expect(page).toContain('<section class="models" id="test" aria-labelledby');
    // The button that sends the test is a real button, disabled until a model is chosen.
    expect(page).toContain('<button type="submit" class="btn" data-test-button disabled hidden>Test</button>');
    expect(page).toContain(">Choose a model</button>");
  });

  it("shows the OpenRouter account line, read live with the key from the vault", async () => {
    await connect({ currentKey: (s) => (s.headers.authorization === `Bearer ${ISSUED_KEY}` ? keyReply({ is_free_tier: true, limit: 10, limit_remaining: 10, usage: 0, workspace_id: "ws-1" }) : new Response(null, { status: 401 })) });
    const page = await (await get()).text();
    expect(page).toContain("<strong>OpenRouter account:</strong> never bought credits · personal key · key limit $10.00, $10.00 left · key spent $0");
    expect(page).toContain('href="https://openrouter.ai/settings/credits"');
    expect(page).toContain("Spends in workspace ws-1.");
    fetcher = fakeFetch({ currentKey: () => new Response("down", { status: 503 }) });
    expect(await (await get()).text()).toContain("could not be read just now.");
  });

  it("runs a chosen model's test call once, on the button's click only, and the provider is then usable", async () => {
    await connect();
    fetcher = fakeFetch();
    const chosen = await post("/openrouter/choose", { model: "openai/gpt-6-luna" });
    expect(chosen.status).toBe(200);
    const html = await chosen.text();
    expect(html).toContain("<strong>openai/gpt-6-luna passed.</strong>");
    expect(html).toContain("Usable: 1 model passed.");
    const calls = fetcher.sent.filter((s) => s.url.endsWith("/chat/completions"));
    expect(calls.map((s) => (s.body as { model: string }).model)).toEqual(["openai/gpt-6-luna"]);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${ISSUED_KEY}`);
    // The ledger has the test call at OpenRouter's reported cost and its generation ID.
    const row = await env.DB.prepare("SELECT task, cost_source, provider_call_id, cost_usd FROM model_calls WHERE user_id = ?").bind(userId).first();
    expect(row).toEqual({ task: "test_call", cost_source: "reported", provider_call_id: "gen-test-0001", cost_usd: 0.0000022 });
  });

  it("reads the account's own model list after Connect, and marks a model the account leaves out", async () => {
    await connect();
    const list = await readAccountList(env.DB, userId, "openrouter");
    expect(list?.models.has("openai/gpt-6-luna")).toBe(true);
    expect(list?.models.has("anthropic/claude-sonnet-5.5")).toBe(false);
    const html = await (await get()).text();
    expect(html).toContain("not offered for your account: your OpenRouter settings (provider preferences, privacy or guardrails) leave it out");
    expect(html).toContain("Every model OpenRouter lists is here.");
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

  it("says the app's own side is not set up without the vault key, and stores nothing", async () => {
    const response = await post("/openrouter/connect", {}, { env: { APP_ORIGIN: ORIGIN, VAULT_KEY: "" } });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("missing VAULT_KEY");
  });

  it("shows a key deleted on OpenRouter as removed, with Connect OpenRouter again", async () => {
    await connect();
    fetcher = fakeFetch({ chat: () => Response.json({ error: { code: 401, message: "User not found." } }, { status: 401 }) });
    await post("/openrouter/choose", { model: "openai/gpt-6-luna" });
    expect(await readCheck(env.DB, userId, "openrouter")).toMatchObject({ state: "revoked", revokedAt: NOW.toISOString() });
    const html = await (await get()).text();
    expect(html).toContain("Removed on OpenRouter's side");
    expect(html).toContain('action="/chief-of-staff/models/setup/providers/openrouter/connect"');
    expect(html).not.toContain('id="test"');
    // Connecting again makes it connected.
    await connect();
    expect(await readCheck(env.DB, userId, "openrouter")).toMatchObject({ state: "passed" });
  });

  it("shows a connection from before 2026-11-27 with no passed test as removed after a 401 test call, with Connect OpenRouter again", async () => {
    await connect();
    // As stored by the old Connect, whose own test call failed: no passed_at.
    await env.DB.prepare("UPDATE provider_checks SET state = 'failed', passed_at = NULL WHERE user_id = ?").bind(userId).run();
    expect(await (await get()).text()).toContain("<strong>Connected</strong>");
    fetcher = fakeFetch({ chat: () => Response.json({ error: { code: 401, message: "User not found." } }, { status: 401 }) });
    await post("/openrouter/choose", { model: "openai/gpt-6-luna" });
    expect(await readCheck(env.DB, userId, "openrouter")).toMatchObject({ state: "revoked", revokedAt: NOW.toISOString() });
    const html = await (await get()).text();
    expect(html).toContain("Removed on OpenRouter's side");
    expect(html).toContain('action="/chief-of-staff/models/setup/providers/openrouter/connect"');
  });

  it("while Test all models runs, the page a chosen model's test returns loads the run's results with a GET, never the POST again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      await connect();
      expect((await post("/openrouter/test-all")).status).toBe(303);
      const chosen = await post("/openrouter/choose", { model: "openai/gpt-6-luna" });
      const html = await chosen.text();
      const body = html.match(/<body data-reload-every="(\d+)" data-reload-to="([^"]+)">/)!;
      const p = listboxPage(pageScripts(html), [], { href: `${BASE}/openrouter/choose`, body: { "data-reload-every": body[1]!, "data-reload-to": body[2]!.replaceAll("&amp;", "&") } });
      vi.advanceTimersByTime(20_000);
      expect(p.sent).toHaveLength(1);
      const [how, to] = p.sent[0]!.split(" ");
      expect(how).toBe("replace");
      const results = await handle(new Request(to!));
      expect(results.status).toBe(200);
      expect(await results.text()).toContain('id="openrouter-test-all"');
    } finally {
      vi.useRealTimers();
    }
  });

  it("Disconnect deletes the key from the vault, the record and the check, and opens that exact key's page on OpenRouter", async () => {
    await connect();
    const hash = await sha256Hex(ISSUED_KEY);
    const keyPage = `https://openrouter.ai/keys/${hash}`;
    const confirm = await (await get("?provider=openrouter&disconnect=1")).text();
    const dialog = confirm.slice(confirm.indexOf('<div class="dialog"'), confirm.indexOf("</div></div>", confirm.indexOf('<div class="dialog"')));
    // One line, with a button to the key's own page; the key itself never reaches the page.
    expect(visibleLines(dialog)).toEqual(["Disconnect OpenRouter?", "The app deletes the key from your vault.", "Also delete this key on OpenRouter.", "Open its page", "Cancel", "Disconnect"]);
    expect(dialog).toContain(`<a class="btn small" href="${keyPage}" target="_blank" rel="noopener noreferrer">Open its page</a>`);
    expect(dialog).toContain("This key is “Chief of staff · 2026-11-27 10:00 UTC” on OpenRouter.");
    expect(dialog).toContain("OpenRouter&#39;s delete-a-key API takes only your own management key");
    expect(confirm).not.toContain(ISSUED_KEY);
    for (const line of visibleLines(dialog)) expect(words(line), line).toBeLessThanOrEqual(12);
    const gone = await post("/openrouter/disconnect");
    expect(gone.status).toBe(303);
    expect(gone.headers.get("location")).toBe(`${BASE}?provider=openrouter&disconnected=1&key=${hash}`);
    const after = await (await handle(new Request(gone.headers.get("location")!))).text();
    const box = after.match(/<div class="tc tc-sw" role="status">[\s\S]*?<\/details><\/div>/)![0];
    expect(visibleLines(box)).toEqual(["Disconnected.", "Also delete this key on OpenRouter.", "Open its page"]);
    expect(box).toContain(`href="${keyPage}"`);
    expect(box).toContain("The key stays valid on OpenRouter until you delete it there");
    expect(after).not.toContain(ISSUED_KEY);
    expect(await readConnection(env.DB, userId, "openrouter")).toBeUndefined();
    expect(await readCheck(env.DB, userId, "openrouter")).toBeUndefined();
    expect(await readAccountList(env.DB, userId, "openrouter")).toBeUndefined();
    expect((await env.DB.prepare("SELECT count(*) AS n FROM vault_items").first<{ n: number }>())!.n).toBe(0);
  });

  it("after Disconnect, links only a well-formed key hash, else the list of keys", async () => {
    for (const key of ["", "&key=nothex", `&key=${"a".repeat(63)}`, `&key=${"a".repeat(64)}"><script>`]) {
      const html = await (await get(`?provider=openrouter&disconnected=1${key}`)).text();
      const box = html.match(/<div class="tc tc-sw" role="status">[\s\S]*?<\/details><\/div>/)![0];
      expect(visibleLines(box), key).toEqual(["Disconnected.", "Also delete the key on OpenRouter.", "Your keys on OpenRouter"]);
      expect(box).toContain('href="https://openrouter.ai/settings/keys"');
      expect(box).not.toContain("<script>");
    }
  });

  it("Connect again mints a new key with a new dated label, and says why under Connect", async () => {
    const before = await (await get()).text();
    expect(before).toContain("<summary>Why a new key each time</summary>");
    expect(before).toContain("OpenRouter&#39;s flow has no way to reuse one");
    await connect();
    await post("/openrouter/disconnect");
    fetcher = fakeFetch();
    const later = new Date("2026-11-28T09:30:00Z");
    const start = await post("/openrouter/connect", {}, { now: later });
    const auth = new URL(start.headers.get("location")!);
    expect(auth.searchParams.get("key_label")).toBe("Chief of staff · 2026-11-28 09:30 UTC");
    await get(`/openrouter/consented?code=code-2&state=${auth.searchParams.get("state")}`, { now: later });
    expect((await readConnection(env.DB, userId, "openrouter"))?.key_label).toBe("Chief of staff · 2026-11-28 09:30 UTC");
    const confirm = await (await get("?provider=openrouter&disconnect=1", { now: later })).text();
    expect(confirm).toContain("This key is “Chief of staff · 2026-11-28 09:30 UTC” on OpenRouter.");
    expect(confirm).toContain("Key on OpenRouter: “Chief of staff · 2026-11-28 09:30 UTC”");
  });

  it("Refresh model list reads OpenRouter's list and the account's again, at most once a minute", async () => {
    await connect();
    const later = new Date("2026-11-27T10:05:00Z");
    fetcher = fakeFetch();
    expect((await post("/openrouter/refresh", {}, { now: later })).status).toBe(303);
    expect(fetcher.sent.map((s) => new URL(s.url).pathname)).toEqual(["/api/v1/models", "/api/v1/models/user"]);
    const again = await post("/openrouter/refresh", {}, { now: new Date("2026-11-27T10:05:30Z") });
    expect(again.status).toBe(429);
    expect(await again.text()).toContain("Refresh it again from 10:06 UTC");
  });

  it("says in one short line when the account's own list could not be read, with OpenRouter's reply in Details", async () => {
    await connect();
    fetcher = fakeFetch({ userModels: () => Response.json({ error: { code: 503, message: "upstream down" } }, { status: 503 }) });
    const failed = await post("/openrouter/refresh", {}, { now: new Date("2026-11-27T10:05:00Z") });
    expect(failed.status).toBe(502);
    const banner = (await failed.text()).match(/<div class="banner warn" role="alert">[\s\S]*?<\/details><\/div>/)![0];
    expect(visibleLines(banner)).toEqual(["Showing OpenRouter's public list."]);
    expect(banner).toContain("did not give your account&#39;s model list (503");
  });

  it("sends Admin a friend's refused model with its plain line and its fix, never the provider's reply", async () => {
    await connect();
    const asked = await post("/openrouter/model-help", { model: "openai/gpt-6-luna", reason: "budget_spent" }, { viewer: "friend" });
    expect(asked.status).toBe(200);
    const row = await env.DB.prepare("SELECT item, reason FROM help_requests WHERE user_id = ?").bind(userId).first<{ item: string; reason: string }>();
    expect(row).toEqual({
      item: "Choose a model: openai/gpt-6-luna",
      reason: "This month's budget is spent. The test call waits until the 1st. Raise the budget on Budgets, then test openai/gpt-6-luna again.",
    });
  });

  it("refuses a form from another site, and a provider that does not exist", async () => {
    const forged = await handle(new Request(`${BASE}/openrouter/connect`, { method: "POST", body: new URLSearchParams(), headers: { origin: "https://elsewhere.example" } }));
    expect(forged.status).toBe(403);
    expect((await post("/bedrock/connect")).status).toBe(404);
  });
});
