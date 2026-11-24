import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBudget } from "../src/proxy/budgets";
import { writeConnection } from "../src/proxy/connections";
import { monthSpend } from "../src/proxy/ledger";
import { callModel, costOf, type ModelCall } from "../src/proxy/proxy";
import { dumpEveryTable, ok, refused, seedPrices, testPlugin, userFor, type TestPlugin } from "./test-plugin";

const NOW = new Date("2026-11-25T10:00:00Z");
const clock = () => NOW;
const PROMPT = "PROMPT-BODY-never-stored";

let bedrock: TestPlugin;
let vertex: TestPlugin;
let userId: string;

const ledger = async (user = userId) =>
  (await env.DB.prepare("SELECT * FROM model_calls WHERE user_id = ? ORDER BY id").bind(user).all<Record<string, unknown>>()).results;

const call = (over: Partial<ModelCall> = {}): ModelCall => ({
  userId,
  task: "fill",
  site: "jobs.example.com",
  runId: "run-1",
  main: { provider: "bedrock", model: "test-sonnet", location: "global", request: { prompt: PROMPT } },
  fallback: { provider: "vertex", model: "test-gemini", location: "global", request: { prompt: PROMPT } },
  ...over,
});

const connect = async (user: string, plugin: TestPlugin) =>
  writeConnection(env.DB, user, plugin, { account: "123456789012", region: "global" }, NOW);

beforeEach(async () => {
  await seedPrices();
  bedrock = testPlugin("bedrock");
  vertex = testPlugin("vertex");
  userId = (await userFor("owner-sub")).id;
  await connect(userId, bedrock);
  await connect(userId, vertex);
  await setBudget(env.DB, userId, "bedrock", 30, "accepted", NOW);
  await setBudget(env.DB, userId, "vertex", 10, "typed", NOW);
});

afterEach(() => vi.restoreAllMocks());

describe("one ledger row per call", () => {
  it("records provider, model, plug-in version, the five token counts, time and cost", async () => {
    bedrock.replies.push(ok({ input: 2000, cachedInput: 5000, cacheWrite: 1000, cacheWrite1h: 500, output: 400 }));
    const outcome = await callModel(env.DB, { bedrock, vertex }, call(), clock);
    expect(outcome).toMatchObject({ kind: "answered", provider: "bedrock", fallback: false, status: 200, body: { reply: "a test reply" } });
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    // 2000 × $3 + 5000 × $0.30 + 1000 × $3.75 (5-minute) + 500 × $6 (1-hour) + 400 × $15, per million.
    const cost = (2000 * 3 + 5000 * 0.3 + 1000 * 3.75 + 500 * 6 + 400 * 15) / 1e6;
    expect(rows[0]).toMatchObject({
      user_id: userId, at: NOW.toISOString(), task: "fill", site: "jobs.example.com", run_id: "run-1",
      provider: "bedrock", model: "test-sonnet", region: "global", tier: "Strongest", plugin_version: "test-bedrock-1",
      status: 200, fallback: 0, fallback_reason: null, input_tokens: 2000, cached_input_tokens: 5000,
      cache_write_tokens: 1000, cache_write_1h_tokens: 500, output_tokens: 400, long_prompt: 0,
    });
    expect(rows[0]!.cost_usd).toBeCloseTo(cost, 12);
    expect(typeof rows[0]!.duration_ms).toBe("number");
  });

  it("costs a call billed at long-prompt rates at the long-prompt rows", async () => {
    bedrock.replies.push(ok({ input: 250_000, cachedInput: 10_000, cacheWrite: 2000, output: 1000, longPrompt: true }));
    await callModel(env.DB, { bedrock, vertex }, call(), clock);
    const [row] = await ledger();
    expect(row).toMatchObject({ input_tokens: 250_000, long_prompt: 1 });
    expect(row!.cost_usd).toBeCloseTo((250_000 * 6 + 10_000 * 0.6 + 2000 * 7.5 + 1000 * 22.5) / 1e6, 12);
  });

  it("costs nothing below list price: a kind used with no row leaves the cost unknown", () => {
    const at = (usdPerMTok: number) => ({ usdPerMTok, source: "azure-retail", dateRead: "", stale: false }) as const;
    const usage = { input: 1e6, cachedInput: 0, cacheWrite: 0, cacheWrite1h: 0, output: 1e6, longPrompt: false };
    expect(costOf(usage, { input: at(1), output: at(4) })).toBe(5);
    expect(costOf({ ...usage, cachedInput: 1 }, { input: at(1), output: at(4) })).toBeUndefined();
    expect(costOf({ ...usage, cacheWrite1h: 1 }, { input: at(1), cache_write: at(1.25), output: at(4) })).toBeUndefined();
  });

  it("answers a call it cannot cost, then refuses the provider until the 1st rather than undercount", async () => {
    // test-sonnet lists no long-prompt 1-hour cache write.
    bedrock.replies.push(ok({ input: 250_000, cacheWrite1h: 4000, output: 1000, longPrompt: true }));
    expect(await callModel(env.DB, { bedrock, vertex }, call({ fallback: undefined }), clock)).toMatchObject({ kind: "answered", provider: "bedrock" });
    const rows = await ledger();
    expect(rows).toEqual([expect.objectContaining({ provider: "bedrock", cache_write_1h_tokens: 4000, long_prompt: 1, cost_usd: null })]);
    expect(await monthSpend(env.DB, userId, "bedrock", NOW)).toBeUndefined();

    const next = await callModel(env.DB, { bedrock, vertex }, call({ fallback: undefined }), clock);
    expect(next).toMatchObject({ kind: "refused", provider: "bedrock", reason: "no_price", resumesOn: "1 December" });
    expect(bedrock.calls).toHaveLength(1);
    expect(await monthSpend(env.DB, userId, "bedrock", new Date("2026-12-01T00:00:00Z"))).toBe(0);
  });

  it("leaves the cost unknown for cache tokens a model lists no price for", async () => {
    vertex.replies.push(ok({ input: 800, cacheWrite: 200, output: 50 }));
    expect(await callModel(env.DB, { bedrock, vertex }, call({ main: call().fallback!, fallback: undefined }), clock)).toMatchObject({
      kind: "answered", provider: "vertex",
    });
    expect(await ledger()).toEqual([expect.objectContaining({ provider: "vertex", cache_write_tokens: 200, cost_usd: null })]);
  });

  it("sends the request untouched with a freshly minted credential", async () => {
    await callModel(env.DB, { bedrock, vertex }, call(), clock);
    expect(bedrock.calls).toEqual([{ credential: bedrock.minted[0], model: "test-sonnet", location: "global", request: { prompt: PROMPT } }]);
  });
});

describe("refusals before any provider is called", () => {
  it("refuses a model with no price, and writes no row", async () => {
    const outcome = await callModel(env.DB, { bedrock, vertex }, call({ main: { provider: "bedrock", model: "unpriced", location: "global", request: {} }, fallback: undefined }), clock);
    expect(outcome).toMatchObject({ kind: "refused", reason: "no_price" });
    expect(bedrock.calls).toHaveLength(0);
    expect(await ledger()).toHaveLength(0);
  });

  it("refuses a provider whose monthly budget is not set, and does not fall back", async () => {
    await env.DB.prepare("DELETE FROM provider_budgets WHERE provider = 'bedrock'").run();
    const outcome = await callModel(env.DB, { bedrock, vertex }, call(), clock);
    expect(outcome).toMatchObject({ kind: "refused", provider: "bedrock", reason: "no_budget" });
    expect(vertex.calls).toHaveLength(0);
  });

  it("refuses a provider not connected, and one with no plug-in", async () => {
    await env.DB.prepare("DELETE FROM provider_connections WHERE provider = 'bedrock'").run();
    expect(await callModel(env.DB, { bedrock, vertex }, call({ fallback: undefined }), clock)).toMatchObject({ reason: "not_connected" });
    expect(await callModel(env.DB, { vertex }, call({ fallback: undefined }), clock)).toMatchObject({ reason: "no_plugin" });
  });

  it("refuses a fallback on the same provider", async () => {
    await expect(
      callModel(env.DB, { bedrock, vertex }, call({ fallback: { provider: "bedrock", model: "test-sonnet", location: "global", request: {} } }), clock),
    ).rejects.toThrow(/another provider/);
  });
});

describe("the monthly budget per provider", () => {
  const spend = (user: string, provider: string, at: string, cost: number) =>
    env.DB.prepare(
      `INSERT INTO model_calls (user_id, at, task, provider, model, region, plugin_version, status, fallback, duration_ms, cost_usd)
       VALUES (?, ?, 'fill', ?, 'm', 'global', 't', 200, 0, 1, ?)`,
    ).bind(user, at, provider, cost).run();

  it("stops calls once the month's spend reaches it, until the 1st", async () => {
    await spend(userId, "bedrock", "2026-11-03T00:00:00Z", 30);
    const outcome = await callModel(env.DB, { bedrock, vertex }, call({ fallback: undefined }), clock);
    expect(outcome).toMatchObject({ kind: "refused", reason: "budget_spent", resumesOn: "1 December" });
    expect(outcome.kind === "refused" && outcome.detail).toBe("model budget for Amazon Bedrock this month reached. Resumes 1 December");
    expect(bedrock.calls).toHaveLength(0);
  });

  it("counts from the 1st: last month's spend does not count", async () => {
    await spend(userId, "bedrock", "2026-10-31T23:59:59Z", 1000);
    expect(await monthSpend(env.DB, userId, "bedrock", NOW)).toBe(0);
    expect(await callModel(env.DB, { bedrock, vertex }, call(), clock)).toMatchObject({ kind: "answered", provider: "bedrock" });
  });

  it("is per provider: one provider's spend does not stop another", async () => {
    await spend(userId, "vertex", "2026-11-03T00:00:00Z", 10);
    expect(await callModel(env.DB, { bedrock, vertex }, call(), clock)).toMatchObject({ kind: "answered", provider: "bedrock" });
  });

  it("is each user's own: another user's spend does not count", async () => {
    const other = (await userFor("friend-sub")).id;
    await spend(other, "bedrock", "2026-11-03T00:00:00Z", 500);
    expect(await callModel(env.DB, { bedrock, vertex }, call(), clock)).toMatchObject({ kind: "answered", provider: "bedrock" });
    expect(await monthSpend(env.DB, other, "bedrock", NOW)).toBe(500);
  });

  it("hands a spent provider's call to the fallback, within the fallback's own budget", async () => {
    await spend(userId, "bedrock", "2026-11-03T00:00:00Z", 31);
    const outcome = await callModel(env.DB, { bedrock, vertex }, call(), clock);
    expect(outcome).toMatchObject({ kind: "answered", provider: "vertex", model: "test-gemini", fallback: true });
    const rows = await ledger();
    expect(rows.filter((r) => r.model !== "m")).toEqual([
      expect.objectContaining({ provider: "vertex", fallback: 1, fallback_reason: "budget_spent", status: 200 }),
    ]);

    await spend(userId, "vertex", "2026-11-04T00:00:00Z", 10);
    expect(await callModel(env.DB, { bedrock, vertex }, call(), clock)).toMatchObject({
      kind: "refused", provider: "vertex", fallback: true, reason: "budget_spent",
    });
  });
});

describe("one fallback across providers", () => {
  it("answers a 429 with the fallback, both calls in the ledger and the fallback named", async () => {
    bedrock.replies.push(refused(429));
    vertex.replies.push(ok({ input: 800, cachedInput: 0, cacheWrite: 0, output: 50 }));
    const outcome = await callModel(env.DB, { bedrock, vertex }, call(), clock);
    expect(outcome).toMatchObject({ kind: "answered", provider: "vertex", fallback: true });
    const rows = await ledger();
    expect(rows).toEqual([
      expect.objectContaining({ provider: "bedrock", status: 429, fallback: 0, input_tokens: 0, cost_usd: 0 }),
      expect.objectContaining({ provider: "vertex", status: 200, fallback: 1, fallback_reason: "refused", input_tokens: 800, output_tokens: 50 }),
    ]);
    expect(rows[1]!.cost_usd).toBeCloseTo((800 * 0.25 + 50 * 1) / 1e6, 12);
  });

  it("answers a 5xx, no reply at all, and a failed credential with the fallback", async () => {
    bedrock.replies.push(refused(503));
    expect(await callModel(env.DB, { bedrock, vertex }, call(), clock)).toMatchObject({ provider: "vertex", fallback: true });
    bedrock.replies.push(new Error("socket hang up"));
    expect(await callModel(env.DB, { bedrock, vertex }, call(), clock)).toMatchObject({ provider: "vertex", fallback: true });
    const revoked = testPlugin("bedrock", { failMint: true });
    expect(await callModel(env.DB, { bedrock: revoked, vertex }, call(), clock)).toMatchObject({ provider: "vertex", fallback: true });
  });

  it("passes the request's own fault (400) back without falling back", async () => {
    bedrock.replies.push(refused(400, { error: "ValidationException" }));
    expect(await callModel(env.DB, { bedrock, vertex }, call(), clock)).toMatchObject({
      kind: "provider_error", provider: "bedrock", status: 400, body: { error: "ValidationException" },
    });
    expect(vertex.calls).toHaveLength(0);
  });

  it("runs the fallback once: a refused fallback is the answer", async () => {
    bedrock.replies.push(refused(429));
    vertex.replies.push(refused(429));
    expect(await callModel(env.DB, { bedrock, vertex }, call(), clock)).toMatchObject({ kind: "provider_error", provider: "vertex", status: 429, fallback: true });
    expect(bedrock.calls).toHaveLength(1);
    expect(vertex.calls).toHaveLength(1);
  });
});

describe("what is never kept", () => {
  it("logs and stores no prompt, reply or credential", async () => {
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void logged.push(...args));
    }
    bedrock.replies.push(refused(429, { error: "busy", echo: PROMPT }));
    vertex.replies.push(ok({ input: 10, cachedInput: 0, cacheWrite: 0, output: 5 }, { reply: "REPLY-BODY-never-stored" }));
    await callModel(env.DB, { bedrock, vertex }, call(), clock);

    const secrets = [PROMPT, "REPLY-BODY-never-stored", ...bedrock.minted, ...vertex.minted];
    expect(secrets.length).toBe(4);
    const dump = JSON.stringify(await dumpEveryTable());
    for (const s of secrets) {
      expect(dump).not.toContain(s);
      expect(JSON.stringify(logged)).not.toContain(s);
    }
  });
});
