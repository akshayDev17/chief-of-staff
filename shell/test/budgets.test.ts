import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { parseBudget, readBudget, suggestBudget, TOKENS_PER_APPLICATION } from "../src/proxy/budgets";
import { writeConnection } from "../src/proxy/connections";
import { ENV, generateKey, serveCerts, signToken, type TestKey } from "./access-fixture";
import { seedPrices, testPlugin, userFor } from "./test-plugin";

const NOW = new Date("2026-11-25T10:00:00Z");
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

let ownerId: string;

beforeEach(async () => {
  await seedPrices();
  ownerId = (await userFor("test-sub")).id;
  await writeConnection(env.DB, ownerId, testPlugin(), { method: "oauth_pkce", key_hash: "a".repeat(64) }, NOW);
  await env.DB.prepare("INSERT INTO user_models (user_id, provider, model, location, added_at) VALUES (?, 'openrouter', 'test-sonnet', 'global', ?)")
    .bind(ownerId, NOW.toISOString())
    .run();
});

describe("the suggested budget", () => {
  it("is the picked model's list price at the design's tokens per application, a month of days", async () => {
    const s = await suggestBudget(env.DB, [{ provider: "openrouter", model: "test-sonnet", location: "global" }], 5);
    // (51,100 × $3 + 3,225 × $15) per million = $0.201675 an application; × 5 × 30 = $30.25, rounded up.
    expect(TOKENS_PER_APPLICATION).toEqual({ input: 51_100, output: 3_225 });
    expect(s).toEqual({ monthlyUsd: 31, model: "test-sonnet", applicationsADay: 5, checkedOn: "2026-11-27" });
  });

  it("uses the dearest picked model, and skips one with no price", async () => {
    const s = await suggestBudget(
      env.DB,
      [
        { provider: "openrouter", model: "test-mini", location: "global" },
        { provider: "openrouter", model: "unpriced", location: "global" },
      ],
      10,
    );
    // (51,100 × $0.25 + 3,225 × $1) per million × 10 × 30 = $4.8, rounded up.
    expect(s?.monthlyUsd).toBe(5);
    expect(await suggestBudget(env.DB, [{ provider: "openrouter", model: "unpriced", location: "global" }], 10)).toBeUndefined();
  });

  it("parses any positive dollar amount, with no upper limit", () => {
    expect(parseBudget("30")).toBe(30);
    expect(parseBudget(" $1,250.50 ")).toBe(1250.5);
    expect(parseBudget("25000")).toBe(25000);
    for (const bad of ["", "0", "-5", "abc", "1e3", "10.123", "9".repeat(400)]) expect(parseBudget(bad)).toBeUndefined();
  });
});

describe("Models › Setup › Budgets", () => {
  it("shows each connected provider with its suggestion, basis, estimate and checked-on date", async () => {
    const response = await send("?per_day=5");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<h3>OpenRouter</h3>");
    expect(html).toContain("about $31 a month");
    expect(html).toContain('<span class="pill warn">estimate</span> · checked on 2026&#8209;11&#8209;27');
    expect(html).toContain("Basis: 5 applications a day, if this provider carried every task, at test-sonnet's list prices");
    expect(html).toContain("Until it is set, this provider's models cannot be called.");
    expect(html).not.toContain("Google Vertex AI");
    expect(html).not.toMatch(/design only/i);
  });

  it("works the suggestion at the volume asked for, 5 a day when none is", async () => {
    expect(await (await send("?per_day=10")).text()).toContain("about $61 a month");
    expect(await (await send("")).text()).toContain("Basis: 5 applications a day");
    expect(await (await send("?per_day=nope")).text()).toContain("Basis: 5 applications a day");
  });

  it("sets the budget when the suggestion is accepted", async () => {
    const response = await post({ provider: "openrouter", accept: "31", amount: "", per_day: "5" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${BASE}?per_day=5`);
    expect(await readBudget(env.DB, ownerId, "openrouter")).toMatchObject({ monthlyUsd: 31, setHow: "accepted" });
    const html = await (await send("?per_day=5")).text();
    expect(html).toContain("Budget set: $31 a month · $0.00 spent since the 1st");
    expect(html).not.toContain("Until it is set");
  });

  it("sets the budget the user types, however large", async () => {
    expect((await post({ provider: "openrouter", amount: "12.50", per_day: "5" })).status).toBe(303);
    expect(await readBudget(env.DB, ownerId, "openrouter")).toMatchObject({ monthlyUsd: 12.5, setHow: "typed" });
    expect((await post({ provider: "openrouter", amount: "25000", per_day: "5" })).status).toBe(303);
    expect(await readBudget(env.DB, ownerId, "openrouter")).toMatchObject({ monthlyUsd: 25000, setHow: "typed" });
  });

  it("sets the typed amount, never the suggestion, when both arrive", async () => {
    expect((await post({ provider: "openrouter", accept: "31", amount: "12", per_day: "5" })).status).toBe(303);
    expect(await readBudget(env.DB, ownerId, "openrouter")).toMatchObject({ monthlyUsd: 12, setHow: "typed" });
    const bad = await post({ provider: "openrouter", accept: "31", amount: "twelve", per_day: "5" });
    expect(bad.status).toBe(400);
    expect(await readBudget(env.DB, ownerId, "openrouter")).toMatchObject({ monthlyUsd: 12, setHow: "typed" });
  });

  it("submits the typed amount on Enter: the suggestion has a form of its own", async () => {
    // Each post form's fields and buttons, as name=value, in page order.
    const forms: string[][] = [];
    const field = { element: (e: Element) => void forms.at(-1)!.push(`${e.getAttribute("name") ?? ""}=${e.getAttribute("value") ?? ""}`) };
    await new HTMLRewriter()
      .on('form[method="post"]', { element: () => void forms.push([]) })
      .on('form[method="post"] input', field)
      .on('form[method="post"] button', field)
      .transform(await send("?per_day=5"))
      .text();
    expect(forms).toEqual([
      ["provider=openrouter", "per_day=5", "accept=31"],
      ["provider=openrouter", "per_day=5", "amount=", "="],
    ]);
  });

  it("refuses an amount that is not a budget, and a provider not connected", async () => {
    const bad = await post({ provider: "openrouter", amount: "0", per_day: "5" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Type a budget in dollars");
    // A removed provider's name is not a provider any more.
    expect((await post({ provider: "bedrock", amount: "10" })).status).toBe(400);
    expect(await readBudget(env.DB, ownerId, "bedrock")).toBeUndefined();
    expect(await readBudget(env.DB, ownerId, "openrouter")).toBeUndefined();
  });

  it("refuses a form posted from another site", async () => {
    const response = await post({ provider: "openrouter", amount: "10" }, { origin: "https://elsewhere.example" });
    expect(response.status).toBe(403);
    expect(await readBudget(env.DB, ownerId, "openrouter")).toBeUndefined();
  });

  it("shows each user only their own providers and budgets", async () => {
    const html = await (await send("", {}, { sub: "friend-sub", email: "friend@example.com" })).text();
    expect(html).toContain("No provider is connected yet.");
    expect(html).not.toContain("<h3>OpenRouter</h3>");
    expect((await post({ provider: "openrouter", amount: "10" })).status).toBe(303);
    const friend = (await userFor("friend-sub")).id;
    expect(await readBudget(env.DB, friend, "openrouter")).toBeUndefined();
  });

  it("refuses an Access token that names no person", async () => {
    expect((await send("", {}, { sub: undefined, email: undefined })).status).toBe(403);
  });
});
