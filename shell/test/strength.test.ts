// Strength by rule B90 (src/prices/tiers.ts): the figure, the lines, free
// and router models, the refresh that stores them, every reader taking the
// stored values, and the price ranges a row shows.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { listOffer } from "../src/models/test-model";
import { readTable } from "../src/models/ready";
import { offeredFor, proposeRoute, readOffered, taskById } from "../src/models/tasks";
import { parseHosts, readHosts } from "../src/prices/openrouter";
import { renderPriceTablePage } from "../src/prices/page";
import { lookupTier } from "../src/prices/lookup";
import { refreshPrices } from "../src/prices/refresh";
import { readStrength } from "../src/prices/strength";
import { currentSnapshot, readFigures, readLatestLines, readSnapshotRows, writeSnapshot, type StoredFigure } from "../src/prices/store";
import {
  blend,
  capFigure,
  figureOf,
  ladderStep,
  linesOf,
  median,
  modelTier,
  percentile,
  strengthSentence,
  tierOf,
  type Host,
  type Lines,
} from "../src/prices/tiers";
import { modelParts, priceText, usd } from "../src/providers/models-table";
import { savePriceCap } from "../src/models/price-caps";
import { setBudget } from "../src/proxy/budgets";
import { writeConnection } from "../src/proxy/connections";
import { callModel } from "../src/proxy/proxy";
import { fakeFetch, MODELS, type Sent } from "./fake-sources";
import { ok, row, TEST_CATALOG, testPlugin, userFor } from "./test-plugin";

const host = (input: number, output: number, extra: Partial<Host> = {}): Host => ({ input, output, standard: true, tools: true, up: true, ...extra });
const AT = "2026-11-27T06:00:00.000Z";

describe("a model's figure", () => {
  it("blends input and output 10:1", () => {
    expect(blend(1, 2)).toBeCloseTo(12 / 11, 12);
    expect(capFigure({ input: 1, output: 2 })).toBeCloseTo(1.0909, 4);
  });

  it("is the median blend of its standard-speed hosts that take tools and are up, with their ranges", () => {
    const f = figureOf(
      [host(0.07, 1.4), host(1.08, 3.98), host(1.5, 4.4), host(9, 9, { up: false }), host(0.01, 0.01, { standard: false }), host(0.02, 0.02, { tools: false })],
      { input: 0.07, output: 1.4 },
      AT,
    );
    expect(f).toMatchObject({ basis: "hosts", hosts: 3, input: { min: 0.07, max: 1.5 }, output: { min: 1.4, max: 4.4 }, readAt: AT });
    expect(f.usd).toBeCloseTo(blend(1.08, 3.98), 12);
  });

  it("averages the middle two of an even count", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(figureOf([host(0.1, 0.5), host(0.2, 1)], { input: 0, output: 0 }, AT).usd).toBeCloseTo((blend(0.1, 0.5) + blend(0.2, 1)) / 2, 12);
  });

  it("takes any standard tool host when none is up, else the headline price", () => {
    expect(figureOf([host(0.2, 1, { up: false })], { input: 9, output: 9 }, AT)).toMatchObject({ basis: "any_host", hosts: 1 });
    const none = figureOf([host(0.2, 1, { tools: false }), host(0.2, 1, { standard: false })], { input: 0.3, output: 1.2 }, AT);
    expect(none).toEqual({ usd: blend(0.3, 1.2), basis: "no_host", hosts: 0, readAt: AT });
    expect(figureOf(undefined, { input: 0.3, output: 1.2 }, AT)).toEqual({ usd: blend(0.3, 1.2), basis: "unread", hosts: 0, readAt: AT });
  });

  it("reads each host's price by the app's standard-price rule, its speed, tools and status", () => {
    const hosts = parseHosts({
      data: {
        endpoints: [
          // A time-of-day price and a dearer reasoning rate count; a long-prompt one does not.
          {
            pricing: { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0.000003", discount: 0.5, overrides: [{ utc_start: 0, utc_end: 6, prompt: "0.0000015" }, { min_prompt_tokens: 200000, prompt: "0.00001" }] },
            service_tier: null, supported_parameters: ["tools"], status: 0,
          },
          { pricing: { prompt: "0.000001", completion: "0.000002" }, service_tier: "flex", supported_parameters: ["max_tokens"], status: -5 },
          { pricing: { prompt: "-1" }, service_tier: null, supported_parameters: ["tools"], status: 0 },
        ],
      },
    });
    expect(hosts).toEqual([
      { input: 1.5, output: 3, standard: true, tools: true, up: true },
      { input: 1, output: 2, standard: false, tools: false, up: false },
    ]);
    expect(() => parseHosts({ data: {} })).toThrow(/endpoints/);
  });

  it("tries a busy endpoints list once more, and gives up on a missing one at once", async () => {
    let calls = 0;
    const busyThenOk = (async () => (++calls === 1 ? new Response("busy", { status: 429 }) : Response.json({ data: { endpoints: [] } }))) as unknown as typeof fetch;
    expect(await readHosts(busyThenOk, "maker/model", 0)).toEqual([]);
    expect(calls).toBe(2);
    calls = 0;
    const missing = (async () => (calls++, new Response("no", { status: 404 }))) as unknown as typeof fetch;
    expect(await readHosts(missing, "maker/model", 0)).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe("the lines", () => {
  it("interpolate percentiles between the nearest ranks", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([0, 10], 90)).toBe(9);
    expect(percentile([1, 2, 3, 4], 100 / 3)).toBeCloseTo(2, 12);
  });

  it("round to the nearest step of the ladder ..., $0.10, $0.15, $0.20, $0.30, $0.50, $0.75, $1, $1.50, ... by ratio", () => {
    expect(ladderStep(0.2955)).toBe(0.3);
    expect(ladderStep(4.816)).toBe(5);
    expect(ladderStep(0.136)).toBe(0.15);
    expect(ladderStep(0.244)).toBe(0.2);
    expect(ladderStep(0.246)).toBe(0.3);
    expect(ladderStep(6.2)).toBe(7.5);
    expect(ladderStep(0.011)).toBe(0.01);
    expect(ladderStep(0.0123)).toBe(0.015);
    expect(ladderStep(87)).toBe(100);
    // By ratio, not by dollar distance: $0.39 is ×1.28 from $0.50 and ×1.30
    // from $0.30; $3.90 is ×1.28 from $5 and ×1.30 from $3.
    expect(ladderStep(0.39)).toBe(0.5);
    expect(ladderStep(3.9)).toBe(5);
  });

  it("sit at the 33 1/3rd and the 90th percentile, rounded, with the month they hold for", () => {
    const figures = [0.0293, 0.136, 0.2045, 1.3436, 2.727];
    const lines = linesOf(figures, new Date("2026-11-27T06:00:00Z"))!;
    expect(lines).toMatchObject({ lower: 0.15, upper: 2, models: 5, month: "2026-11", computedAt: "2026-11-27T06:00:00.000Z" });
    expect(lines.lowerRaw).toBeCloseTo(percentile(figures, 100 / 3), 12);
    expect(lines.upperRaw).toBeCloseTo(percentile(figures, 90), 12);
    expect(linesOf([], new Date())).toBeUndefined();
  });

  it("make Smallest below the lower line, Middle below the upper one, Strongest from it up", () => {
    const lines = { lower: 0.3, upper: 5 };
    expect([0.2999, 0.3, 4.999, 5].map((x) => tierOf(x, lines))).toEqual(["Smallest", "Middle", "Middle", "Strongest"]);
  });

  it("make a free model Smallest, a router's cap its figure, and nothing without a figure or lines", () => {
    const lines = { lower: 0.3, upper: 5 };
    expect(modelTier({ free: true, figure: 9 }, lines)).toBe("Smallest");
    expect(modelTier({ free: true }, undefined)).toBe("Smallest");
    // The owner's Auto Router cap of $1/$2 blends to $1.09: Middle.
    expect(modelTier({ figure: capFigure({ input: 1, output: 2 }) }, lines)).toBe("Middle");
    expect(modelTier({}, lines)).toBeUndefined();
    expect(modelTier({ figure: 1 }, undefined)).toBeUndefined();
  });

  it("say what strength is with the lines in force, in one sentence", () => {
    expect(strengthSentence({ lower: 0.3, upper: 5 }, "OpenRouter")).toBe(
      "Strength is a model's typical price per million tokens (10 input to 1 output, at its middle OpenRouter host): Smallest under $0.30, Middle under $5, Strongest $5 and up, the cheapest third and dearest tenth of OpenRouter's tool-use models, rechecked on the 1st of each month; nobody sets it by hand.",
    );
    expect(strengthSentence({ lower: 0.15, upper: 7.5 }, "OpenRouter")).toContain("Smallest under $0.15, Middle under $7.50, Strongest $7.50 and up");
  });
});

// ---------- the refresh ----------

// OpenRouter's endpoints list, one host per entry, in the API's shape.
const apiHost = (input: number, output: number, extra: Record<string, unknown> = {}) => ({
  pricing: { prompt: String(input / 1e6), completion: String(output / 1e6) },
  service_tier: null,
  supported_parameters: ["tools", "max_tokens"],
  status: 0,
  ...extra,
});

const modelOf = (s: Sent): string => decodeURI(new URL(s.url).pathname.replace(/^\/api\/v1\/models\//, "").replace(/\/endpoints$/, ""));

const endpoints = (byModel: Record<string, unknown[] | number>) => (s: Sent) => {
  const hosts = byModel[modelOf(s)];
  if (hosts === undefined) return new Response("not found", { status: 404 });
  if (typeof hosts === "number") return new Response("down", { status: hosts });
  return Response.json({ data: { id: modelOf(s), endpoints: hosts } });
};

const SONNET = "anthropic/claude-sonnet-5.5";
const FLASH = "deepseek/deepseek-v4.1-flash-1017";
const HAIKU = "anthropic/claude-haiku-5.5";
const NEMO = "mistralai/mistral-nemo";
const LUNA = "openai/gpt-6-luna";
const FREE = "inclusionai/ling-3.2-flash:free";

const HOSTS: Record<string, unknown[] | number> = {
  [SONNET]: [apiHost(2, 10), apiHost(6, 30, { service_tier: "priority" })],
  [FLASH]: [apiHost(0.07, 1.4), apiHost(1.08, 3.98), apiHost(1.5, 4.4), apiHost(9, 9, { status: -2 }), apiHost(0.5, 2, { service_tier: "flex" })],
  [HAIKU]: [apiHost(0.1, 0.5, { status: -5 }), apiHost(0.2, 1, { status: -5 })],
  [NEMO]: [apiHost(0.029, 0.03, { supported_parameters: ["max_tokens"] })],
  [LUNA]: 503,
};

// The models whose endpoints list a refresh asked for (a busy one twice).
const endpointReads = (f: { sent: Sent[] }) => [...new Set(f.sent.filter((s) => s.url.endsWith("/endpoints")).map(modelOf))].sort();

const daily = (now: string, byModel = HOSTS, extra: Parameters<typeof fakeFetch>[0] = {}) => {
  const fetcher = fakeFetch({ endpoints: endpoints(byModel), ...extra });
  return refreshPrices({ db: env.DB, fetcher, now: new Date(now), daily: true, hostRetryPauseMs: 0 }).then(() => fetcher);
};
const button = (now: string, byModel = HOSTS, extra: Parameters<typeof fakeFetch>[0] = {}) => {
  const fetcher = fakeFetch({ endpoints: endpoints(byModel), ...extra });
  return refreshPrices({ db: env.DB, fetcher, now: new Date(now), hostRetryPauseMs: 0 }).then(() => fetcher);
};

const figuresNow = async (): Promise<Map<string, StoredFigure>> => {
  const s = (await currentSnapshot(env.DB))!;
  return new Map((await readFigures(env.DB, s.id)).map((f) => [f.model, f]));
};

// The fixture's list with one model's headline price changed.
const withHeadline = (model: string, prompt: string, completion: string) => ({
  data: MODELS.data.map((m) => (m.id === model ? { ...m, pricing: { ...m.pricing, prompt, completion } } : m)),
});

describe("the daily refresh's strength", () => {
  it("reads every tiered model's hosts, stores each figure beside the snapshot, and draws the month's lines from them", async () => {
    const fetcher = await daily("2026-11-27T06:00:00Z");
    // Every priced model with tool use that is neither free nor a router; the
    // free one, the router, the alias and the models with no tool use are not read.
    expect(endpointReads(fetcher)).toEqual([HAIKU, SONNET, FLASH, NEMO, LUNA].sort());
    expect(fetcher.sent.filter((s) => s.url.endsWith(`${LUNA}/endpoints`))).toHaveLength(2);
    const f = await figuresNow();
    expect([...f.keys()].sort()).toEqual([HAIKU, SONNET, FLASH, FREE, NEMO, LUNA].sort());
    expect(f.get(SONNET)).toMatchObject({ basis: "hosts", hosts: 1, input: { min: 2, max: 2 } });
    expect(f.get(SONNET)!.usd).toBeCloseTo(blend(2, 10), 12);
    expect(f.get(FLASH)).toMatchObject({ basis: "hosts", hosts: 3, input: { min: 0.07, max: 1.5 }, output: { min: 1.4, max: 4.4 } });
    expect(f.get(FLASH)!.usd).toBeCloseTo(blend(1.08, 3.98), 12);
    expect(f.get(HAIKU)).toMatchObject({ basis: "any_host", hosts: 2 });
    expect(f.get(NEMO)).toMatchObject({ basis: "no_host", hosts: 0 });
    // Its list could not be read: its headline price.
    expect(f.get(LUNA)).toMatchObject({ basis: "unread", usd: blend(0.1, 0.5) });
    expect(f.get(FREE)).toMatchObject({ free: true, usd: 0 });

    const lines = (await readLatestLines(env.DB))!;
    const paid = [...f.values()].filter((x) => !x.free).map((x) => x.usd);
    expect(lines).toMatchObject({ month: "2026-11", models: 5, lower: ladderStep(percentile(paid, 100 / 3)), upper: ladderStep(percentile(paid, 90)) });
    expect([lines.lower, lines.upper]).toEqual([0.15, 2]);
  });

  it("works the lines out again only at the first daily refresh of a month, never on Refresh model list", async () => {
    await daily("2026-11-27T06:00:00Z");
    const november = (await readLatestLines(env.DB))!;
    // Prices fall the next day: the figures follow, the month's lines hold.
    const cheaper = { ...HOSTS, [SONNET]: [apiHost(0.2, 1)], [FLASH]: [apiHost(0.1, 0.2)] };
    await daily("2026-11-28T06:00:00Z", cheaper);
    expect((await figuresNow()).get(SONNET)!.usd).toBeCloseTo(blend(0.2, 1), 12);
    expect(await readLatestLines(env.DB)).toEqual(november);
    // Refresh model list on the 1st, before the day's refresh, keeps them too.
    await button("2026-12-01T05:00:00Z", cheaper);
    expect(await readLatestLines(env.DB)).toEqual(november);
    // The 1st's daily refresh draws December's.
    await daily("2026-12-01T06:00:00Z", cheaper);
    const december = (await readLatestLines(env.DB))!;
    expect(december).toMatchObject({ month: "2026-12", computedAt: "2026-12-01T06:00:00.000Z" });
    expect(december.upper).toBeLessThan(november.upper);
    // And a second daily refresh that month keeps December's.
    await daily("2026-12-02T06:00:00Z", HOSTS);
    expect(await readLatestLines(env.DB)).toEqual(december);
  });

  it("draws the first lines of all at the first refresh of any kind, so none are shipped as constants", async () => {
    expect(await readLatestLines(env.DB)).toBeUndefined();
    await button("2026-11-27T10:00:00Z");
    expect(await readLatestLines(env.DB)).toMatchObject({ month: "2026-11", lower: 0.15, upper: 2 });
  });

  it("keeps the last figures and the lines when OpenRouter's list cannot be read", async () => {
    await daily("2026-11-27T06:00:00Z");
    const before = await figuresNow();
    const fetcher = await daily("2026-12-01T06:00:00Z", HOSTS, { models: () => new Response("down", { status: 503 }) });
    expect(endpointReads(fetcher)).toEqual([]);
    expect(await figuresNow()).toEqual(before);
    expect((await readLatestLines(env.DB))!.month).toBe("2026-11");
  });
});

describe("Refresh model list's strength", () => {
  beforeEach(async () => {
    await daily("2026-11-27T06:00:00Z");
  });

  it("reads only the models that are new, changed their headline, or were last not read; the rest keep their figures", async () => {
    const before = await figuresNow();
    const fetcher = await button("2026-11-27T10:00:00Z", HOSTS, { models: () => Response.json(withHeadline(FLASH, "0.0000004", "0.0000016")) });
    expect(endpointReads(fetcher)).toEqual([FLASH, LUNA].sort());
    const after = await figuresNow();
    for (const m of [SONNET, HAIKU, NEMO]) expect(after.get(m)).toEqual(before.get(m));
    expect(after.get(FLASH)!.readAt).toBe("2026-11-27T10:00:00.000Z");
  });

  it("gives a model its headline price when its list cannot be read, never an earlier snapshot's host figure", async () => {
    // Its hosts ($4/$20) sit above its headline ($2/$10).
    await daily("2026-11-28T06:00:00Z", { ...HOSTS, [SONNET]: [apiHost(4, 20)] });
    expect((await figuresNow()).get(SONNET)).toMatchObject({ basis: "hosts", usd: blend(4, 20) });
    // The next daily refresh reads its list again and fails: its headline, read now.
    await daily("2026-11-29T06:00:00Z", { ...HOSTS, [SONNET]: 503 });
    const failed = (await figuresNow()).get(SONNET)!;
    expect(failed).toMatchObject({ basis: "unread", hosts: 0, usd: blend(2, 10), readAt: "2026-11-29T06:00:00.000Z" });
    expect(failed.input).toBeUndefined();
    // Refresh model list reads it again, as last not read, and it fails once more: its headline still.
    const fetcher = await button("2026-11-29T10:00:00Z", { ...HOSTS, [SONNET]: 503 });
    expect(endpointReads(fetcher)).toContain(SONNET);
    expect((await figuresNow()).get(SONNET)).toMatchObject({ basis: "unread", usd: blend(2, 10), readAt: "2026-11-29T10:00:00.000Z" });
  });
});

describe("a snapshot with no figures", () => {
  it("takes each model's headline price and draws the lines from those until a refresh stores them", async () => {
    await writeSnapshot(env.DB, {
      takenAt: "2026-11-27T06:00:00Z", status: "good", results: [], catalog: TEST_CATALOG,
      rows: [row("test-luna", "input", 0.1), row("test-luna", "output", 0.5), row("test-mini", "input", 0.25), row("test-mini", "output", 1), row("test-sonnet", "input", 3), row("test-sonnet", "output", 15)],
    });
    const s = await readStrength(env.DB, await currentSnapshot(env.DB));
    expect(s.figures.get("openrouter|test-mini")).toMatchObject({ basis: "unread", usd: blend(0.25, 1) });
    expect(s.figures.has("openrouter|openrouter/auto")).toBe(false);
    expect(s.lines).toMatchObject(linesOf([blend(0.1, 0.5), blend(0.25, 1), blend(3, 15)], new Date("2026-11-27T06:00:00Z"))!);
    expect(await lookupTier(env.DB, { provider: "openrouter", model: "test-sonnet" })).toBe("Strongest");
  });
});

// ---------- every reader takes the stored figure ----------

// Test Luna's headline ($0.10/$0.50, $0.14 blended) says Smallest; its hosts
// say $1.20, Middle. Test Mini's ($0.25/$1, $0.32) says Middle; its stored
// figure, $0.20, Smallest. Every reader must show the stored strength.
const LINES: Lines = { lower: 0.3, upper: 5, lowerRaw: 0.2955, upperRaw: 4.816, models: 3, month: "2026-11", computedAt: AT };
const stored = (model: string, usd: number, extra: Partial<StoredFigure> = {}): StoredFigure => ({ provider: "openrouter", model, usd, basis: "hosts", hosts: 1, free: false, readAt: AT, ...extra });

async function seedStored() {
  await writeSnapshot(env.DB, {
    takenAt: AT, status: "good", results: [], catalog: TEST_CATALOG, lines: LINES,
    rows: [row("test-luna", "input", 0.1), row("test-luna", "output", 0.5), row("test-mini", "input", 0.25), row("test-mini", "output", 1), row("test-sonnet", "input", 3), row("test-sonnet", "output", 15)],
    figures: [
      stored("test-luna", 1.2, { hosts: 3, input: { min: 0.07, max: 1.2 }, output: { min: 1.4, max: 4.4 } }),
      stored("test-mini", 0.2, { hosts: 2, input: { min: 0.25, max: 0.25 }, output: { min: 1, max: 1 } }),
      stored("test-sonnet", 4.09),
    ],
  });
}

describe("every reader of strength", () => {
  let userId: string;
  const plugin = testPlugin("openrouter", { routers: ["openrouter/auto"] });
  const plugins = () => ({ openrouter: plugin });

  beforeEach(async () => {
    await seedStored();
    userId = (await userFor("owner-sub")).id;
  });

  it("the model list: each row's chip, typical price and ranges", async () => {
    const { rows, lines } = await listOffer(env.DB, plugins(), userId, "openrouter");
    expect(lines).toMatchObject({ lower: 0.3, upper: 5 });
    const of = (m: string) => rows.find((r) => r.model === m)!;
    expect(of("test-luna")).toMatchObject({ tier: "Middle", typicalUsd: 1.2, ranges: { input: { min: 0.07, max: 1.2 }, output: { min: 1.4, max: 4.4 } } });
    // Two hosts at one price: no range.
    expect(of("test-mini")).toMatchObject({ tier: "Smallest", typicalUsd: 0.2 });
    expect(of("test-mini").ranges).toBeUndefined();
    expect(of("test-sonnet").tier).toBe("Middle");
    expect(of("openrouter/auto").tier).toBeUndefined();
  });

  it("a router's chip from the blend of its cap, never from a list price", async () => {
    await savePriceCap(env.DB, userId, "openrouter", "openrouter/auto", { input: 1, output: 2 }, new Date(AT));
    const auto = (await listOffer(env.DB, plugins(), userId, "openrouter")).rows.find((r) => r.model === "openrouter/auto")!;
    expect(auto).toMatchObject({ tier: "Middle", typicalUsd: capFigure({ input: 1, output: 2 }) });
    await savePriceCap(env.DB, userId, "openrouter", "openrouter/auto", { input: 5, output: 5 }, new Date(AT));
    expect((await listOffer(env.DB, plugins(), userId, "openrouter")).rows.find((r) => r.model === "openrouter/auto")!.tier).toBe("Strongest");
  });

  it("the dropdowns and proposals: a task's strength, the cheapest first by the typical price, never a router", async () => {
    await savePriceCap(env.DB, userId, "openrouter", "openrouter/auto", { input: 0.5, output: 0.5 }, new Date(AT));
    const offered = await readOffered(env.DB, plugins(), userId);
    const score = taskById("score")!;
    // Middle, cheapest typical first: the router's $0.50, Test Luna's $1.20,
    // Test Sonnet's $4.09, though Luna's headline input is the lowest.
    expect(offeredFor(score, offered).map((m) => m.model)).toEqual(["openrouter/auto", "test-luna", "test-sonnet"]);
    expect(proposeRoute(score, offered)).toMatchObject({ main: { model: "test-luna" }, fallback: { model: "test-sonnet" } });
    expect(offeredFor(taskById("match")!, offered).map((m) => m.model)).toEqual(["test-mini"]);
  });

  it("the strength chip on the model table, with each row's price or ranges, and the sentence under it", async () => {
    const table = await readTable(env.DB, plugins(), userId, "openrouter");
    const parts = modelParts({ plugin, viewer: "owner", rows: table.rows, usedBy: new Map(), view: {}, now: new Date(AT), ...(table.lines ? { lines: table.lines } : {}) });
    const rowOf = (m: string) => parts.rows.split("\n").find((l) => l.includes(`data-id="${m}"`))!;
    expect(rowOf("test-luna")).toContain('data-strength="Middle"');
    expect(rowOf("test-luna")).toContain("<span>$0.07–$1.20 in</span><span class=\"sep\"> · </span><span>$1.40–$4.40 out</span>");
    expect(rowOf("test-mini")).toContain('data-strength="Smallest"');
    expect(rowOf("test-mini")).toContain('<span class="price num">$0.25 / $1.00</span>');
    expect(parts.foot).toContain("Smallest under $0.30, Middle under $5, Strongest $5 and up");
    expect(parts.foot).not.toContain("input price");
  });

  it("the ledger's tier column and lookupTier", async () => {
    await writeConnection(env.DB, userId, plugin, { method: "oauth_pkce", key_hash: "a".repeat(64) }, new Date(AT));
    await setBudget(env.DB, userId, "openrouter", 30, "accepted", new Date(AT));
    plugin.replies.push(ok({ input: 10, output: 2, reportedCostUsd: 0.001 }));
    await callModel(env.DB, plugins(), { userId, task: "fill", site: "none", main: { provider: "openrouter", model: "test-luna", location: "global", request: { prompt: "p" } } }, () => new Date(AT));
    const { results } = await env.DB.prepare("SELECT model, tier FROM model_calls").all<{ model: string; tier: string }>();
    expect(results).toEqual([{ model: "test-luna", tier: "Middle" }]);
    expect(await lookupTier(env.DB, { provider: "openrouter", model: "test-mini" })).toBe("Smallest");
  });

  it("Admin · Price table", async () => {
    const snapshot = (await currentSnapshot(env.DB))!;
    const rows = await readSnapshotRows(env.DB, snapshot.id);
    const html = renderPriceTablePage({ snapshot, rows, alerts: [], sort: { column: "model", dir: "asc" }, strength: await readStrength(env.DB, snapshot) });
    const tierCell = (m: string) => html.split("<tr>").find((r) => r.includes(`>${m}<`))!.match(/data-l="Strength">([^<]+)</)![1];
    expect([tierCell("test-luna"), tierCell("test-mini"), tierCell("test-sonnet")]).toEqual(["Middle", "Smallest", "Middle"]);
    expect(html).toContain("Smallest under $0.30, Middle under $5, Strongest $5 and up");
  });
});

describe("a row's price", () => {
  it("shows each side's range where the hosts differ, else input / output", () => {
    expect(priceText({ input: 0.1, output: 0.5 })).toBe("$0.10 / $0.50");
    expect(priceText({ input: 0.07, output: 1.4 }, { input: { min: 0.07, max: 1.2 }, output: { min: 1.4, max: 4.4 } })).toBe("$0.07–$1.20 in · $1.40–$4.40 out");
    expect(priceText({ input: 1, output: 2 }, { input: { min: 1, max: 1 }, output: { min: 1.5, max: 2 } })).toBe("$1.00 in · $1.50–$2.00 out");
  });

  it("rounds a range like every other price: at most four significant figures, never fewer than the cents, no trailing zeros", () => {
    // DeepSeek V4 Pro 0813 on the live walk, 2026-11-28: "$1.97604–$5.00 out".
    expect(priceText({ input: 0.0999, output: 5 }, { input: { min: 0.0999, max: 1.65 }, output: { min: 1.97604, max: 5 } })).toBe("$0.0999–$1.65 in · $1.976–$5.00 out");
    expect([1.97604, 0.125, 2, 0.0699, 0.1, 0.029, 1.4, 123.45, 0.000123456, 0].map(usd)).toEqual([
      "$1.976", "$0.125", "$2.00", "$0.0699", "$0.10", "$0.029", "$1.40", "$123.45", "$0.0001235", "$0.00",
    ]);
    // The single prices the rows show keep their form.
    expect(priceText({ input: 0.0699, output: 1.4 })).toBe("$0.0699 / $1.40");
  });
});
