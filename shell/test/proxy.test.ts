import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBudget } from "../src/proxy/budgets";
import { writeConnection } from "../src/proxy/connections";
import { monthSpend } from "../src/proxy/ledger";
import { recentAlerts } from "../src/prices/store";
import { callModel, costOf, type ModelCall } from "../src/proxy/proxy";
import { dumpEveryTable, ok, refused, seedPrices, testPlugin, userFor, type TestPlugin } from "./test-plugin";

const NOW = new Date("2026-11-27T10:00:00Z");
const clock = () => NOW;
const PROMPT = "PROMPT-BODY-never-stored";

let openrouter: TestPlugin;
let userId: string;

const ledger = async (user = userId) =>
  (await env.DB.prepare("SELECT * FROM model_calls WHERE user_id = ? ORDER BY id").bind(user).all<Record<string, unknown>>()).results;

const sonnet = { provider: "openrouter", model: "test-sonnet", location: "global", request: { prompt: PROMPT } } as const;
const mini = { provider: "openrouter", model: "test-mini", location: "global", request: { prompt: PROMPT } } as const;

const call = (over: Partial<ModelCall> = {}): ModelCall => ({ userId, task: "fill", site: "jobs.example.com", runId: "run-1", main: sonnet, fallback: mini, ...over });
const plugins = () => ({ openrouter });

beforeEach(async () => {
  await seedPrices();
  openrouter = testPlugin();
  userId = (await userFor("owner-sub")).id;
  await writeConnection(env.DB, userId, openrouter, { method: "oauth_pkce", key_hash: "a".repeat(64) }, NOW);
  await setBudget(env.DB, userId, "openrouter", 30, "accepted", NOW);
});

afterEach(() => vi.restoreAllMocks());

describe("one ledger row per call", () => {
  it("takes the cost OpenRouter reported, and keeps its generation ID", async () => {
    openrouter.replies.push({ ...ok({ input: 2000, cachedInput: 5000, cacheWrite1h: 500, output: 400, reportedCostUsd: 0.0123 }), callId: "gen-abc" });
    const outcome = await callModel(env.DB, plugins(), call(), clock);
    expect(outcome).toMatchObject({ kind: "answered", provider: "openrouter", fallback: false, status: 200, costUsd: 0.0123 });
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: userId, at: NOW.toISOString(), task: "fill", site: "jobs.example.com", run_id: "run-1",
      provider: "openrouter", model: "test-sonnet", region: "global", tier: "Strongest", plugin_version: "test-openrouter-1",
      status: 200, fallback: 0, fallback_reason: null, input_tokens: 2000, cached_input_tokens: 5000,
      cache_write_tokens: 0, cache_write_1h_tokens: 500, output_tokens: 400, long_prompt: 0, costed_conservatively: null,
      cost_usd: 0.0123, cost_source: "reported", provider_call_id: "gen-abc",
    });
    expect(await monthSpend(env.DB, userId, "openrouter", NOW)).toBe(0.0123);
  });

  it("prices a reply that reports no cost from the table, at its own rows", async () => {
    openrouter.replies.push(ok({ input: 2000, cachedInput: 5000, cacheWrite: 1000, cacheWrite1h: 500, output: 400 }));
    await callModel(env.DB, plugins(), call(), clock);
    const [row] = await ledger();
    expect(row).toMatchObject({ cost_source: "list_price", provider_call_id: null });
    expect(row!.cost_usd).toBeCloseTo((2000 * 3 + 5000 * 0.3 + 1000 * 3.75 + 500 * 6 + 400 * 15) / 1e6, 12);
    expect(await recentAlerts(env.DB)).toEqual([]);
  });

  it("prices a long prompt at the long-prompt rows when no cost is reported", async () => {
    openrouter.replies.push(ok({ input: 250_000, cachedInput: 10_000, cacheWrite: 2000, output: 1000, longPrompt: true }));
    await callModel(env.DB, plugins(), call(), clock);
    const [row] = await ledger();
    expect(row).toMatchObject({ input_tokens: 250_000, long_prompt: 1 });
    expect(row!.cost_usd).toBeCloseTo((250_000 * 6 + 10_000 * 0.6 + 2000 * 7.5 + 1000 * 22.5) / 1e6, 12);
  });

  it("costs a kind with no row of its own never below the provider: cached input at input, else the dearest listed rate", () => {
    const at = (usdPerMTok: number) => ({ usdPerMTok, source: "openrouter-models", dateRead: "", stale: false }) as const;
    const short = { input: at(1), cache_write: at(1.25), output: at(4) };
    const long = { input: at(2), output: at(6) };
    const usage = { input: 1e6, cachedInput: 0, cacheWrite: 0, cacheWrite1h: 0, output: 1e6, longPrompt: false };
    expect(costOf(usage, short, long)).toEqual({ usd: 5, source: "list_price", conservative: {} });
    expect(costOf({ ...usage, cachedInput: 1e6 }, short, long)).toEqual({ usd: 6, source: "list_price", conservative: { cached_input: 1 } });
    expect(costOf({ ...usage, cacheWrite1h: 1e6 }, short, long)).toEqual({ usd: 11, source: "list_price", conservative: { cache_write_1h: 6 } });
    expect(costOf({ ...usage, reportedCostUsd: 0.5 }, short, long)).toEqual({ usd: 0.5, source: "reported", conservative: {} });
  });

  it("adds the fee per call to a call that used tokens, and never prices a missing kind at it", () => {
    const at = (usdPerMTok: number) => ({ usdPerMTok, source: "openrouter-models", dateRead: "", stale: false }) as const;
    const short = { input: at(1), output: at(4), request: at(20_000) };
    const usage = { input: 1e6, cachedInput: 0, cacheWrite: 0, cacheWrite1h: 0, output: 1e6, longPrompt: false };
    expect(costOf(usage, short, {}).usd).toBeCloseTo(5.02, 12);
    expect(costOf({ ...usage, cacheWrite1h: 1e6 }, short, {})).toMatchObject({ conservative: { cache_write_1h: 4 } });
    expect(costOf({ ...usage, input: 0, output: 0 }, short, {}).usd).toBe(0);
  });

  it("alerts the maintainers once a UTC day for a kind priced conservatively", async () => {
    const miniCall = call({ main: mini, fallback: undefined });
    for (let i = 0; i < 3; i++) {
      openrouter.replies.push(ok({ input: 800, cachedInput: 300, output: 50 }));
      await callModel(env.DB, plugins(), miniCall, clock);
    }
    const alerts = await recentAlerts(env.DB);
    expect(alerts).toEqual([expect.objectContaining({ kind: "price_missing", detail: expect.stringContaining("test-mini at OpenRouter (global) has no list price for cached_input") })]);
    const [row] = await ledger();
    expect(JSON.parse(row!.costed_conservatively as string)).toEqual({ cached_input: 0.25 });
  });

  it("sends the request untouched with a freshly minted credential", async () => {
    await callModel(env.DB, plugins(), call(), clock);
    expect(openrouter.calls[0]).toMatchObject({ model: "test-sonnet", location: "global", request: { prompt: PROMPT } });
    expect(openrouter.calls[0]!.credential).toBe(openrouter.minted[0]);
  });
});

describe("refusals before any provider is called", () => {
  it("refuses a model with no price, one the plug-in cannot call, and writes no row", async () => {
    expect(await callModel(env.DB, plugins(), call({ main: { ...sonnet, model: "unpriced" }, fallback: undefined }), clock)).toMatchObject({ kind: "refused", reason: "no_price" });
    const cannot = testPlugin("openrouter", { cannotCall: ["test-sonnet"] });
    expect(await callModel(env.DB, { openrouter: cannot }, call({ fallback: undefined }), clock)).toMatchObject({ kind: "refused", reason: "not_callable" });
    expect(await ledger()).toEqual([]);
  });

  it("refuses a provider whose monthly budget is not set, and a user not connected", async () => {
    await env.DB.prepare("DELETE FROM provider_budgets").run();
    expect(await callModel(env.DB, plugins(), call(), clock)).toMatchObject({ kind: "refused", reason: "no_budget", fallback: false });
    const other = (await userFor("friend-sub")).id;
    await setBudget(env.DB, other, "openrouter", 5, "typed", NOW);
    expect(await callModel(env.DB, plugins(), call({ userId: other }), clock)).toMatchObject({ kind: "refused", reason: "not_connected" });
  });

  it("refuses a fallback that is the main model itself", async () => {
    await expect(callModel(env.DB, plugins(), call({ fallback: sonnet }), clock)).rejects.toThrow(/another model/);
  });
});

describe("the monthly budget", () => {
  it("stops calls once the month's spend reaches it, until the 1st, and the fallback with them", async () => {
    await setBudget(env.DB, userId, "openrouter", 0.01, "typed", NOW);
    openrouter.replies.push(ok({ input: 1000, output: 100, reportedCostUsd: 0.02 }));
    await callModel(env.DB, plugins(), call(), clock);
    // The fallback shares the provider's budget, so it is not tried.
    expect(await callModel(env.DB, plugins(), call(), clock)).toMatchObject({ kind: "refused", reason: "budget_spent", resumesOn: "1 December", fallback: false });
    expect(openrouter.calls).toHaveLength(1);
    expect(await callModel(env.DB, plugins(), call(), () => new Date("2026-12-01T00:00:00Z"))).toMatchObject({ kind: "answered" });
  });

  it("is each user's own: another user's spend does not count", async () => {
    const other = (await userFor("friend-sub")).id;
    await env.DB.prepare("INSERT INTO model_calls (user_id, at, task, provider, model, region, plugin_version, status, fallback, duration_ms, cost_usd) VALUES (?, ?, 'fill', 'openrouter', 'test-sonnet', 'global', 'x', 200, 0, 1, 1000)")
      .bind(other, NOW.toISOString())
      .run();
    expect(await callModel(env.DB, plugins(), call(), clock)).toMatchObject({ kind: "answered" });
  });
});

describe("one fallback: another model on the same provider", () => {
  it("answers a 429 with the fallback model, both calls in the ledger and the fallback named", async () => {
    openrouter.replies.push(refused(429), ok({ input: 10, output: 1, reportedCostUsd: 0.000001 }));
    const outcome = await callModel(env.DB, plugins(), call(), clock);
    expect(outcome).toMatchObject({ kind: "answered", model: "test-mini", fallback: true });
    expect((await ledger()).map((r) => [r.model, r.status, r.fallback, r.fallback_reason])).toEqual([
      ["test-sonnet", 429, 0, null],
      ["test-mini", 200, 1, "refused"],
    ]);
  });

  it("answers a 5xx and no reply at all with the fallback", async () => {
    openrouter.replies.push(refused(502), ok({ input: 1, output: 1 }));
    expect(await callModel(env.DB, plugins(), call(), clock)).toMatchObject({ kind: "answered", fallback: true });
    openrouter.replies.push(new Error("network"), ok({ input: 1, output: 1 }));
    expect(await callModel(env.DB, plugins(), call(), clock)).toMatchObject({ kind: "answered", fallback: true });
  });

  it("passes the request's own fault, no credits, and a missing key back without falling back", async () => {
    openrouter.replies.push(refused(400));
    expect(await callModel(env.DB, plugins(), call(), clock)).toMatchObject({ kind: "provider_error", status: 400, fallback: false });
    openrouter.replies.push(refused(402));
    expect(await callModel(env.DB, plugins(), call(), clock)).toMatchObject({ kind: "provider_error", status: 402, fallback: false });
    const noKey = testPlugin("openrouter", { refuseMint: true });
    expect(await callModel(env.DB, { openrouter: noKey }, call(), clock)).toMatchObject({ kind: "refused", reason: "credential_failed", fallback: false });
  });

  it("runs the fallback once: a refused fallback is the answer", async () => {
    openrouter.replies.push(refused(429), refused(429));
    expect(await callModel(env.DB, plugins(), call(), clock)).toMatchObject({ kind: "provider_error", status: 429, model: "test-mini", fallback: true });
    expect(openrouter.calls).toHaveLength(2);
  });
});

describe("what is never kept", () => {
  it("logs and stores no prompt, reply or credential", async () => {
    const logged: string[] = [];
    for (const level of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, level).mockImplementation((...a) => void logged.push(a.join(" ")));
    openrouter.replies.push(ok({ input: 1, cachedInput: 5, output: 1 }, { reply: "REPLY-BODY-never-stored" }));
    await callModel(env.DB, plugins(), call({ main: mini, fallback: undefined }), clock);
    const stored = JSON.stringify(await dumpEveryTable()) + logged.join("\n");
    for (const secret of [PROMPT, "REPLY-BODY-never-stored", ...openrouter.minted]) expect(stored).not.toContain(secret);
  });
});
