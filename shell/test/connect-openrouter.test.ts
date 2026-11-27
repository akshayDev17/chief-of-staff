// Connect OpenRouter end to end through the Providers routes, with the real
// plug-in against a stand-in OpenRouter (fake-sources.ts): the consent page,
// the code exchange, the key in the vault, the test call, the account's model
// list, Disconnect, and the cron's checks.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAccountList } from "../src/models/account-list";
import { refreshPrices } from "../src/prices/refresh";
import { readCurrentCatalog } from "../src/prices/store";
import { providerPlugins } from "../src/providers/index";
import { readCheck, runDueChecks } from "../src/providers/check";
import { handleProviders } from "../src/providers/page";
import { sha256Hex } from "../src/providers/openrouter";
import { vaultSecrets } from "../src/providers/secrets";
import { setBudget } from "../src/proxy/budgets";
import { readConnection } from "../src/proxy/connections";
import { fakeFetch, ISSUED_KEY, type Overrides } from "./fake-sources";
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
    const { results } = await env.DB.prepare("SELECT name FROM vault_items WHERE user_id = ?").bind(userId).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["provider-verifier:openrouter"]);
  });

  it("prefills $10 before any budget is set", async () => {
    const auth = new URL((await post("/openrouter/connect")).headers.get("location")!);
    expect(auth.searchParams.get("limit")).toBe("10.00");
  });

  it("puts the issued key in the vault, sealed, and never anywhere else; the test call passes on its own", async () => {
    const logged: string[] = [];
    for (const level of ["log", "warn", "error", "info"] as const) vi.spyOn(console, level).mockImplementation((...a) => void logged.push(a.join(" ")));
    const back = await connect();
    expect(back.status).toBe(303);
    expect(await readConnection(env.DB, userId, "openrouter")).toEqual({ method: "oauth_pkce", key_hash: await sha256Hex(ISSUED_KEY) });
    const check = await readCheck(env.DB, userId, "openrouter");
    // The cheapest paid model on the account's own live list (the captured
    // fixture), since the key's figures cannot tell the account's credit.
    expect(check).toMatchObject({ state: "passed", result: { verdict: "passed", model: "mistralai/mistral-nemo", why: "cheapest paid model your OpenRouter account offers", reply: { status: 200, text: "OK" } } });
    expect(check?.consentState).toBeUndefined();
    // The test call went out with the issued key.
    expect(fetcher.sent.find((s) => s.url.endsWith("/chat/completions"))!.headers.authorization).toBe(`Bearer ${ISSUED_KEY}`);
    const stored = JSON.stringify(await dumpEveryTable());
    expect(stored).not.toContain(ISSUED_KEY);
    expect(logged.join("\n")).not.toContain(ISSUED_KEY);
    const page = await (await get()).text();
    expect(page).not.toContain(ISSUED_KEY);
    expect(page).toContain("key in your vault, never shown");
    expect(page).toContain("Test call passed");
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
    expect(html).toContain("Every model OpenRouter lists is here, from its public list, which needs no key.");
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
    await post("/openrouter/retry");
    expect(await readCheck(env.DB, userId, "openrouter")).toMatchObject({ state: "revoked", result: { reason: "not_set_up", reply: { status: 401, message: "User not found." } } });
    const html = await (await get()).text();
    expect(html).toContain("Removed on the provider's side");
    expect(html).toContain("The connection isn&#39;t set up yet, or was removed.");
    expect(html).toContain('action="/chief-of-staff/models/setup/providers/openrouter/connect"');
  });

  it("Disconnect deletes the key from the vault, the record and the check, and says how to delete it on OpenRouter", async () => {
    await connect();
    const confirm = await (await get("?provider=openrouter&disconnect=1")).text();
    expect(confirm).toContain("The key itself stays valid on OpenRouter until you delete it there");
    expect(confirm).toContain("https://openrouter.ai/settings/keys");
    expect((await post("/openrouter/disconnect")).status).toBe(303);
    expect(await readConnection(env.DB, userId, "openrouter")).toBeUndefined();
    expect(await readCheck(env.DB, userId, "openrouter")).toBeUndefined();
    expect(await readAccountList(env.DB, userId, "openrouter")).toBeUndefined();
    expect((await env.DB.prepare("SELECT count(*) AS n FROM vault_items").first<{ n: number }>())!.n).toBe(0);
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

  it("refuses a form from another site, and a provider that does not exist", async () => {
    const forged = await handle(new Request(`${BASE}/openrouter/connect`, { method: "POST", body: new URLSearchParams(), headers: { origin: "https://elsewhere.example" } }));
    expect(forged.status).toBe(403);
    expect((await post("/bedrock/connect")).status).toBe(404);
  });
});

describe("the cron's checks", () => {
  it("never picks a check left from a removed provider, so it cannot crowd out OpenRouter's", async () => {
    await env.DB.prepare("INSERT INTO provider_checks (user_id, provider, state, next_try_at) VALUES (?, 'bedrock', 'checking', '2026-11-01T00:00:00Z')").bind(userId).run();
    expect(await runDueChecks(env.DB, await plugins(), NOW)).toBe(0);
  });
});
