// The OpenRouter budget bar (AKS-136, reworked for OpenRouter): the key's own
// figures read from OpenRouter server side, the three parts, and the bar on
// Models › Setup › Budgets and on the Connect panel.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keyUsageFromBody, readKeyUsage } from "../src/providers/openrouter";
import { handleProviders } from "../src/providers/page";
import { barParts, readKeyFigure, renderBudgetBar, type KeyFigure } from "../src/proxy/budget-bar";
import { setBudget } from "../src/proxy/budgets";
import { handleBudgets } from "../src/proxy/budgets-page";
import { writeConnection } from "../src/proxy/connections";
import { writeLedgerRow } from "../src/proxy/ledger";
import { fakeFetch, ISSUED_KEY, keyReply } from "./fake-sources";
import { seedPrices, testPlugin, testSecrets, userFor } from "./test-plugin";

const NOW = new Date("2026-11-27T10:41:00Z");
const ORIGIN = "https://cos.example.com";
const HASH = "b".repeat(64);
const read = (usage: Partial<{ monthlyUsd: number; limitUsd: number; limitRemainingUsd: number; limitReset: string }> = {}): KeyFigure => ({
  usage: { monthlyUsd: 0, ...usage },
  readAt: NOW.toISOString(),
});

let userId: string;

beforeEach(async () => {
  await seedPrices();
  userId = (await userFor("bar-sub")).id;
});
afterEach(() => vi.restoreAllMocks());

const spend = (costUsd: number, at = NOW) =>
  writeLedgerRow(env.DB, {
    userId, at, task: "cover_letter", site: "", provider: "openrouter", model: "test-sonnet", region: "global", pluginVersion: "test", status: 200,
    inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, outputTokens: 100, longPrompt: false, durationMs: 10,
    costUsd, costSource: "reported", costedConservatively: {},
  });

describe("OpenRouter's figures for the key", () => {
  it("are this month's usage plus the BYOK usage, with the key's limit only when it has one", () => {
    expect(keyUsageFromBody({ data: { usage: 40, usage_monthly: 9.36, byok_usage_monthly: 0.5, limit: null, limit_remaining: null, limit_reset: null } })).toEqual({ monthlyUsd: 9.86 });
    expect(keyUsageFromBody({ data: { usage_monthly: 1, limit: 60, limit_remaining: 50.64, limit_reset: "monthly" } })).toEqual({
      monthlyUsd: 1, limitUsd: 60, limitRemainingUsd: 50.64, limitReset: "monthly",
    });
    for (const bad of [{}, { data: {} }, { data: { usage_monthly: "9" } }, { data: { usage_monthly: -1 } }, "nope", null]) expect(keyUsageFromBody(bad)).toBeUndefined();
  });

  it("are read from GET /api/v1/key with the key itself", async () => {
    const fetcher = fakeFetch({ currentKey: () => keyReply({ usage_monthly: 2.5 }) });
    expect(await readKeyUsage(ISSUED_KEY, fetcher)).toEqual({ monthlyUsd: 2.5 });
    expect(fetcher.sent).toHaveLength(1);
    expect(fetcher.sent[0]).toMatchObject({ url: "https://openrouter.ai/api/v1/key", method: "GET", headers: { authorization: `Bearer ${ISSUED_KEY}` } });
  });

  it("come with the key from the vault, or a plain reason, never an error", async () => {
    const secrets = testSecrets();
    expect(await readKeyFigure(secrets, userId, NOW, fakeFetch())).toEqual({ unread: "the app holds no OpenRouter key for you" });
    await secrets.put(userId, "openrouter", "key", ISSUED_KEY, NOW);
    expect(await readKeyFigure(secrets, userId, NOW, fakeFetch())).toEqual({ usage: { monthlyUsd: 0 }, readAt: NOW.toISOString() });
    const deleted = fakeFetch({ currentKey: () => Response.json({ error: { code: 401, message: "User not found." } }, { status: 401 }) });
    expect(await readKeyFigure(secrets, userId, NOW, deleted)).toEqual({ unread: "OpenRouter no longer accepts the key" });
    const down = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    expect(await readKeyFigure(secrets, userId, NOW, down)).toEqual({ unread: "OpenRouter did not answer" });
    expect(await readKeyFigure({ ...secrets, read: () => Promise.reject(new Error("no VAULT_KEY")) }, userId, NOW)).toEqual({ unread: "the app could not open your vault" });
  });
});

describe("the bar's three parts", () => {
  it("is OpenRouter's figure, what the app counted beyond it, and the budget left", () => {
    expect(barParts(60, 9.4, read({ monthlyUsd: 9.36 }))).toEqual({ reported: 9.36, extra: expect.closeTo(0.04, 10), spent: 9.4, left: 50.6, over: 0 });
  });

  it("shows OpenRouter's figure when it is the larger, with no striped part", () => {
    expect(barParts(60, 9, read({ monthlyUsd: 10 }))).toEqual({ reported: 10, extra: 0, spent: 10, left: 50, over: 0 });
  });

  it("is all the app's own count when OpenRouter's figure could not be read", () => {
    expect(barParts(30, 4, { unread: "OpenRouter did not answer" })).toEqual({ reported: 0, extra: 4, spent: 4, left: 26, over: 0 });
  });

  it("has nothing left, and says by how much, past the budget", () => {
    expect(barParts(10, 12, read({ monthlyUsd: 11 }))).toEqual({ reported: 11, extra: 1, spent: 12, left: 0, over: 2 });
  });
});

describe("the bar", () => {
  const regions = (html: string) => [...html.matchAll(/<button type="button" class="bb-seg bb-(\w+)"(?: style="width:([\d.]+)%")?/g)].map((m) => [m[1], m[2]]);

  it("labels each part, for hover, tap and focus, with a link to OpenRouter's Activity page", () => {
    const html = renderBudgetBar({ budgetUsd: 60, ledgerUsd: 9.4, key: read({ monthlyUsd: 9.36 }) });
    expect(regions(html)).toEqual([["real", "15.60"], ["est", "0.07"], ["left", undefined]]);
    for (const [id, label] of [["real", "Spent, as OpenRouter reports it: $9.36"], ["est", "Counted by the app, not in OpenRouter&#39;s figure yet: $0.04"], ["left", "Budget left: $50.60"]]) {
      expect(html).toContain(`data-region="${id}" aria-label="${label}" aria-describedby="bbt-${id}" aria-expanded="false"></button><div class="bb-tip bb-tip-${id}" id="bbt-${id}">`);
    }
    expect(html.match(/href="https:\/\/openrouter.ai\/activity" target="_blank" rel="noopener noreferrer"/g)).toHaveLength(3);
    expect(html).toContain("$9.40 of $60 · $50.60 left");
    expect(html).toContain("read at 10:41 UTC");
    expect(html).toContain("The app's own count this month, which stops calls at the budget: $9.40.");
    expect(html).toContain('href="/chief-of-staff/models/setup/budgets">Change the budget</a>');
    expect(html).not.toContain("more than the app's own count");
  });

  it("leaves out a part worth $0, but keeps it in the key", () => {
    const html = renderBudgetBar({ budgetUsd: 60, ledgerUsd: 9, key: read({ monthlyUsd: 10 }) });
    expect(regions(html)).toEqual([["real", "16.67"], ["left", undefined]]);
    expect(html).toContain("Counted by the app, not in OpenRouter&#39;s figure yet $0.00</li>");
    expect(html).toContain("OpenRouter's figure is $1.00 more than the app's own count; the bar shows the larger.");
  });

  it("says when OpenRouter's figure could not be read, and shows the app's own count", () => {
    const html = renderBudgetBar({ budgetUsd: 30, ledgerUsd: 4, key: { unread: "OpenRouter did not answer" } });
    expect(regions(html)).toEqual([["est", "13.33"], ["left", undefined]]);
    expect(html).toContain("OpenRouter's own figure could not be read just now (OpenRouter did not answer), so the bar shows the app's own count this month");
  });

  it("is full past the budget and says by how much", () => {
    const html = renderBudgetBar({ budgetUsd: 10, ledgerUsd: 12, key: read({ monthlyUsd: 11 }) });
    expect(regions(html)).toEqual([["real", "91.67"], ["est", "8.33"]]);
    expect(html).toContain("$12.00 of $10 · over by $2.00");
  });

  it("warns when the key's own limit on OpenRouter comes before the budget, else notes it", () => {
    const tight = renderBudgetBar({ budgetUsd: 60, ledgerUsd: 9.4, key: read({ monthlyUsd: 9.4, limitUsd: 10, limitRemainingUsd: 0.6, limitReset: "monthly" }), keyPageHref: `https://openrouter.ai/keys/${HASH}` });
    expect(tight).toContain('<p class="bb-note bb-warn" role="note">The key\'s own credit limit on OpenRouter: $10 (resets monthly), $0.60 left. OpenRouter refuses calls at it, before your budget is used up; change it on <a href="https://openrouter.ai/keys/' + HASH);
    const loose = renderBudgetBar({ budgetUsd: 60, ledgerUsd: 9.4, key: read({ monthlyUsd: 9.4, limitUsd: 100, limitRemainingUsd: 90.6 }) });
    expect(loose).toContain("The key's own credit limit on OpenRouter: $100, $90.60 left. OpenRouter refuses calls at it, whatever is left of your budget");
    expect(loose).not.toContain("bb-warn");
    expect(renderBudgetBar({ budgetUsd: 60, ledgerUsd: 1, key: read({ monthlyUsd: 1 }) })).not.toContain("credit limit");
  });
});

describe("the bar on the Models pages", () => {
  let fetcher: ReturnType<typeof fakeFetch>;

  beforeEach(async () => {
    fetcher = fakeFetch({ currentKey: () => keyReply({ usage_monthly: 1.5, limit: 31, limit_remaining: 29.5, limit_reset: "monthly" }) });
    await writeConnection(env.DB, userId, testPlugin(), { method: "oauth_pkce", key_hash: HASH }, NOW);
    await testSecrets().put(userId, "openrouter", "key", ISSUED_KEY, NOW);
    await spend(1.5);
    await spend(0.25);
    // Last month's call is not this month's spend.
    await spend(5, new Date("2026-10-31T23:59:00Z"));
  });

  const budgetsPage = () =>
    handleBudgets(new Request(`${ORIGIN}/chief-of-staff/models/setup/budgets`), env.DB, { openrouter: testPlugin() }, userId, NOW, { secrets: testSecrets(), fetcher });

  it("is on Budgets once the budget is set, read from OpenRouter server side, the key never on the page", async () => {
    expect(await (await budgetsPage()).text()).not.toContain('<div class="bb" data-budget-bar>');
    expect(fetcher.sent).toHaveLength(0);
    await setBudget(env.DB, userId, "openrouter", 31, "accepted", NOW);
    const html = await (await budgetsPage()).text();
    expect(html).toContain('<div class="bb" data-budget-bar>');
    expect(html).toContain("$1.75 of $31 · $29.25 left");
    expect(html).toContain("Spent, as OpenRouter reports it $1.50</li>");
    expect(html).toContain("Counted by the app, not in OpenRouter&#39;s figure yet $0.25</li>");
    expect(html).toContain('href="#amount-openrouter">Change the budget</a>');
    expect(html).toContain("The key's own credit limit on OpenRouter: $31 (resets monthly), $29.50 left.");
    expect(html).toContain('document.querySelectorAll("[data-budget-bar]")');
    expect(html).not.toContain(ISSUED_KEY);
    expect(fetcher.sent.map((s) => s.url)).toEqual(["https://openrouter.ai/api/v1/key"]);
  });

  it("is on the Connect panel under the monthly budget", async () => {
    await setBudget(env.DB, userId, "openrouter", 31, "accepted", NOW);
    const response = await handleProviders(new Request(`${ORIGIN}/chief-of-staff/models/setup/providers`), {
      db: env.DB, plugins: { openrouter: testPlugin() }, readPlugins: async () => ({ openrouter: testPlugin() }), secrets: testSecrets(),
      userId, viewer: "friend", appOrigin: ORIGIN, now: NOW, fetcher,
    });
    const html = await response.text();
    expect(html).toMatch(/<strong>Monthly budget:<\/strong> \$31 · <a href="[^"]+">Budgets<\/a><\/p><div class="bb" data-budget-bar>/);
    expect(html).toContain("$1.75 of $31 · $29.25 left");
    expect(html).toContain('href="/chief-of-staff/models/setup/budgets">Change the budget</a>');
    expect(html).not.toContain(ISSUED_KEY);
  });
});
