import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { blockedReason, modelPrices, parseModels, perMillion } from "../src/prices/openrouter";
import { displayRows, renderPriceTablePage } from "../src/prices/page";
import { mergeRows, refreshPrices } from "../src/prices/refresh";
import { currentSnapshot, readCurrentCatalog, readSnapshotRows, recentAlerts, rollBackLatestSnapshot } from "../src/prices/store";
import { modelTier, tierFromInputPrice } from "../src/prices/tiers";
import { fakeFetch, MODELS } from "./fake-sources";
import { row } from "./test-plugin";

const NOW = new Date("2026-11-27T06:00:00Z");
const LATER = new Date("2026-11-28T06:00:00Z");

describe("OpenRouter's model list as the price table", () => {
  const parsed = parseModels(MODELS, NOW);
  const rowsOf = (model: string) => parsed.rows.filter((r) => r.model === model);
  const priceOf = (model: string, kind: string, longPrompt = false) => rowsOf(model).find((r) => r.tokenKind === kind && r.longPrompt === longPrompt)?.usdPerMTok;

  it("reads per-token prices as USD per million tokens, exactly", () => {
    expect(perMillion("0.0000001")).toBe(0.1);
    expect(perMillion("0.000000029")).toBe(0.029);
    expect(perMillion("0")).toBe(0);
    for (const bad of ["-1", "", "abc", undefined, null]) expect(perMillion(bad)).toBeUndefined();
    expect(priceOf("openai/gpt-6-luna", "input")).toBe(0.1);
    expect(priceOf("openai/gpt-6-luna", "output")).toBe(0.5);
    expect(priceOf("openai/gpt-6-luna", "cached_input")).toBe(0.01);
    expect(priceOf("openai/gpt-6-luna", "cache_write")).toBe(0.125);
  });

  it("lists every model OpenRouter lists, and says why it cannot call the router and the alias", () => {
    expect(parsed.catalog.models.map((m) => m.id)).toEqual(MODELS.data.map((m) => m.id).sort());
    const auto = parsed.catalog.models.find((m) => m.id === "openrouter/auto")!;
    expect(auto.blocked).toMatch(/prices it by the model it picks/);
    expect(parsed.catalog.models.find((m) => m.id.startsWith("~"))!.blocked).toMatch(/alias/);
    expect(rowsOf("openrouter/auto")).toEqual([]);
    expect(parsed.leftOut).toBe(2);
    // A model that gives no text cannot do a task.
    expect(blockedReason({ id: "x/image", architecture: { input_modalities: ["text"], output_modalities: ["image"] }, pricing: { prompt: "0.000001", completion: "0.00001" } })).toMatch(/no text/);
  });

  it("lets a free model be chosen at $0, and marks tool support and retirement", () => {
    const free = MODELS.data.find((m) => m.id.endsWith(":free"))!.id;
    expect(parsed.catalog.models.find((m) => m.id === free)!.blocked).toBeUndefined();
    expect(priceOf(free, "input")).toBe(0);
    expect(parsed.catalog.models.find((m) => m.id === "mistralai/pixtral-large-2502")!.tools).toBe(false);
    expect(parsed.catalog.models.find((m) => m.id === "openai/gpt-6-luna")!.tools).toBe(true);
    expect(parsed.catalog.models.find((m) => m.id === "nvidia/nemotron-3.5-content-safety")!.expires).toBe("2026-11-30");
  });

  it("keeps prompt-length prices as long-prompt rows, from the smallest threshold", () => {
    expect(priceOf("anthropic/claude-haiku-5.5", "input")).toBe(0.1);
    expect(priceOf("anthropic/claude-haiku-5.5", "cache_write_1h")).toBe(0.2);
    expect(priceOf("anthropic/claude-haiku-5.5", "input", true)).toBe(0.5);
    expect(priceOf("anthropic/claude-haiku-5.5", "output", true)).toBe(2.5);
    expect(parsed.catalog.models.find((m) => m.id === "anthropic/claude-haiku-5.5")!.longPromptFrom).toBe(100_000);
    const tiers = modelPrices({ prompt: "0.00000003", completion: "0.0000001", overrides: [{ min_prompt_tokens: 256000, prompt: "0.0000002" }, { min_prompt_tokens: 32000, prompt: "0.0000001" }] });
    expect(tiers.longPromptFrom).toBe(32000);
    expect(tiers.long.input).toBe(0.2);
  });

  it("takes the dearest time-of-day price as the standard price, never a cheaper hour's", () => {
    const night = modelPrices({ prompt: "0.0000003", completion: "0.0000012", overrides: [{ utc_start: 0, utc_end: 100, prompt: "0.00000015" }, { utc_start: 100, utc_end: 400, prompt: "0.0000004" }] });
    expect(night.standard.input).toBe(0.4);
    expect(night.standard.output).toBe(1.2);
    expect(night.long).toEqual({});
  });

  it("keeps the fee per call as a row, and prices output at a dearer reasoning rate", () => {
    const fee = modelPrices({ prompt: "0.000001", completion: "0.000002", internal_reasoning: "0.000005", request: "0.0004" });
    expect(fee.standard).toEqual({ input: 1, output: 5, request: 400 });
    expect(modelPrices({ prompt: "0.000001", completion: "0.000002", internal_reasoning: "0" }).standard.output).toBe(2);
  });
});

describe("the daily refresh", () => {
  it("stores a snapshot with OpenRouter's rows and model list, and nothing else", async () => {
    const fetcher = fakeFetch();
    const { snapshotId, results } = await refreshPrices({ db: env.DB, fetcher, now: NOW });
    expect(fetcher.sent.map((s) => s.url)).toEqual(["https://openrouter.ai/api/v1/models"]);
    // No key is sent to read the public list.
    expect(fetcher.sent[0]!.headers.authorization).toBeUndefined();
    expect(results).toEqual([expect.objectContaining({ source: "openrouter-models", ok: true, unmapped: 2 })]);
    expect((await currentSnapshot(env.DB))!.id).toBe(snapshotId);
    expect((await readSnapshotRows(env.DB, snapshotId)).every((r) => r.provider === "openrouter" && r.region === "global")).toBe(true);
    expect((await readCurrentCatalog(env.DB))!.readAt).toBe(NOW.toISOString());
  });

  it("keeps the last good rows, marked stale, and the last model list when OpenRouter fails, with an alert", async () => {
    await refreshPrices({ db: env.DB, fetcher: fakeFetch(), now: NOW });
    const { snapshotId, results } = await refreshPrices({ db: env.DB, fetcher: fakeFetch({ models: () => new Response("down", { status: 503 }) }), now: LATER });
    expect(results[0]).toMatchObject({ ok: false, error: "HTTP 503" });
    const rows = await readSnapshotRows(env.DB, snapshotId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.stale && r.dateRead === "2026-11-27")).toBe(true);
    expect((await readCurrentCatalog(env.DB))!.readAt).toBe(NOW.toISOString());
    expect((await recentAlerts(env.DB))[0]).toMatchObject({ kind: "refresh_failed" });
  });

  it("refuses a reply with no list, rather than emptying the table", async () => {
    const { results } = await refreshPrices({ db: env.DB, fetcher: fakeFetch({ models: () => Response.json({ nothing: true }) }), now: NOW });
    expect(results[0]!.ok).toBe(false);
  });

  it("rolls back to the snapshot before, its model list with it", async () => {
    await refreshPrices({ db: env.DB, fetcher: fakeFetch(), now: NOW });
    const cheaper = { data: MODELS.data.map((m) => (m.id === "openai/gpt-6-luna" ? { ...m, pricing: { ...m.pricing, prompt: "0.00000005" } } : m)) };
    await refreshPrices({ db: env.DB, fetcher: fakeFetch({ models: () => Response.json(cheaper) }), now: LATER });
    await rollBackLatestSnapshot(env.DB);
    const current = (await currentSnapshot(env.DB))!;
    const luna = (await readSnapshotRows(env.DB, current.id)).find((r) => r.model === "openai/gpt-6-luna" && r.tokenKind === "input");
    expect(luna?.usdPerMTok).toBe(0.1);
    expect((await readCurrentCatalog(env.DB))!.readAt).toBe(NOW.toISOString());
  });
});

describe("tiers and merging", () => {
  it("draws the bands at $0.50 and $2.50", () => {
    expect(tierFromInputPrice(0.4999)).toBe("Smallest");
    expect(tierFromInputPrice(0.5)).toBe("Middle");
    expect(tierFromInputPrice(2.5)).toBe("Strongest");
  });

  it("takes a model's tier from its standard input price, never a long-prompt one", () => {
    expect(modelTier("openrouter", [row("m", "input", 0.1), row("m", "input", 0.6, true), row("m", "output", 9)])).toBe("Smallest");
    expect(modelTier("openrouter", [row("m", "output", 9)])).toBeUndefined();
  });

  it("keeps the higher of two prices for one row, flagged", () => {
    const { rows, disagreements } = mergeRows([row("m", "input", 1), row("m", "input", 2)]);
    expect(rows).toEqual([expect.objectContaining({ usdPerMTok: 2, disagreement: true })]);
    expect(disagreements).toHaveLength(1);
  });
});

describe("Admin · Price table", () => {
  it("shows OpenRouter's rows, one source, its limits page, and no region choice", async () => {
    await refreshPrices({ db: env.DB, fetcher: fakeFetch(), now: NOW });
    const snapshot = (await currentSnapshot(env.DB))!;
    const rows = await readSnapshotRows(env.DB, snapshot.id);
    const html = renderPriceTablePage({ snapshot, rows, alerts: await recentAlerts(env.DB), sort: { column: "provider", dir: "asc" } });
    expect(html).toContain("OpenRouter models API: ok");
    expect(html).toContain("openai/gpt-6-luna");
    expect(html).toContain("openrouter.ai</a>, read 2026-11-27");
    expect(html).toContain("Free (:free) models, which a $0 account can use, allow 20 requests a minute");
    expect(html).not.toContain("does not offer");
    expect(html).not.toMatch(/Bedrock|Foundry|Vertex|maintainer-read/);
    expect(displayRows(rows).find((r) => r.model === "anthropic/claude-haiku-5.5")).toMatchObject({ input: 0.1, longInput: 0.5 });
  });
});
