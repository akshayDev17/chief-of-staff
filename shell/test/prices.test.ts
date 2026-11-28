import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { blockedReason, everyPriceZero, isTrulyFreeTextModel, modelPrices, parseModels, perMillion } from "../src/prices/openrouter";
import { displayRows, renderPriceTablePage } from "../src/prices/page";
import { mergeRows, refreshPrices } from "../src/prices/refresh";
import { currentSnapshot, readCurrentCatalog, readSnapshotRows, recentAlerts, rollBackLatestSnapshot } from "../src/prices/store";
import { readStrength } from "../src/prices/strength";
import { fakeFetch, MODELS } from "./fake-sources";
import { row } from "./test-plugin";

const NOW = new Date("2026-11-27T06:00:00Z");
// The fixture's models a figure tiers from their hosts: priced, with tool use,
// neither free nor a router.
const TIERED_PAID = ["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5", "deepseek/deepseek-v4.1-flash-1017", "mistralai/mistral-nemo", "openai/gpt-6-luna"];
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

  it("lists every model OpenRouter lists but the never-testable ones, and marks the router for a price cap", () => {
    const dropped = (id: string) => id.startsWith("~") || id.endsWith(":batch") || id === "google/lyria-3-clip-preview";
    expect(parsed.catalog.models.map((m) => m.id)).toEqual(MODELS.data.map((m) => m.id).filter((id) => !dropped(id)).sort());
    expect(parsed.catalog.dropped).toEqual({ batch: 1, alias: 1, router: 0, unusable: 1 });
    // Every listed model that charges per search or per request, dropped ones too.
    expect(parsed.catalog.feeModels).toEqual(MODELS.data.filter((m) => Number((m.pricing as unknown as Record<string, string>).web_search ?? 0) > 0 || Number((m.pricing as unknown as Record<string, string>).request ?? 0) > 0).map((m) => m.id).sort());
    expect(parsed.catalog.feeModels).toContain("~openai/gpt-luna-latest");
    expect(rowsOf("openai/gpt-oss-20b:batch")).toEqual([]);
    // The router takes request parameters, so a price cap can hold it; it
    // has no rows of its own, and gives images too, which the cap prices at 0.
    const auto = parsed.catalog.models.find((m) => m.id === "openrouter/auto")!;
    expect(auto).toMatchObject({ router: true });
    expect(auto.blocked).toBeUndefined();
    expect(rowsOf("openrouter/auto")).toEqual([]);
    // A router no cap can bound is dropped: one that takes no request
    // parameters (a panel of models, say), or one another maker publishes.
    const router = (id: string, supported_parameters: string[]) => ({ id, name: id, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "-1", completion: "-1" }, supported_parameters });
    const more = parseModels({ data: [...MODELS.data, router("openrouter/panel", []), router("someone/router", ["max_tokens"])] }, NOW);
    expect(more.catalog.dropped).toEqual({ batch: 1, alias: 1, router: 2, unusable: 1 });
    expect(more.catalog.models.map((m) => m.id)).not.toContain("openrouter/panel");
    expect(more.catalog.models.map((m) => m.id)).not.toContain("someone/router");
    // The alias, the batch variant, the router and the music model (below).
    expect(parsed.leftOut).toBe(4);
    expect(blockedReason({ id: "openrouter/auto", architecture: { input_modalities: ["text"], output_modalities: ["text", "image"] }, pricing: { prompt: "-1" } })).toBeUndefined();
    // A model that gives no text cannot do a task.
    expect(blockedReason({ id: "x/image", architecture: { input_modalities: ["text"], output_modalities: ["image"] }, pricing: { prompt: "0.000001", completion: "0.00001" } })).toMatch(/no text/);
  });

  it("never offers a model that also gives audio, images or video, even at $0 a token", () => {
    // The captured entry: "0" per prompt and completion token, but it gives
    // text and audio, and OpenRouter charges it per clip.
    const lyria = MODELS.data.find((m) => m.id === "google/lyria-3-clip-preview")!;
    expect(lyria.architecture.output_modalities).toEqual(["text", "audio"]);
    expect([lyria.pricing.prompt, lyria.pricing.completion]).toEqual(["0", "0"]);
    expect(isTrulyFreeTextModel(lyria)).toBe(false);
    // Never testable, so never listed: dropped like the aliases, and counted.
    expect(parsed.catalog.models.find((m) => m.id === lyria.id)).toBeUndefined();
    expect(parsed.catalog.dropped!.unusable).toBe(1);
    expect(blockedReason(lyria)).toBe("it also gives audio, images or video, priced beyond its token rates");
    expect(rowsOf(lyria.id)).toEqual([]);
    expect(blockedReason({ id: "x/pic", architecture: { input_modalities: ["text"], output_modalities: ["image", "text"] }, pricing: { prompt: "0", completion: "0" } })).toMatch(/also gives/);
  });

  it("calls a model free only when it gives only text and every price it lists is 0", () => {
    const free = MODELS.data.find((m) => m.id.endsWith(":free"))!;
    expect(isTrulyFreeTextModel(free)).toBe(true);
    expect(parsed.catalog.models.find((m) => m.id === free.id)!.free).toBe(true);
    // Only one fixture entry is free.
    expect(parsed.catalog.models.filter((m) => m.free).map((m) => m.id)).toEqual([free.id]);
    // A captured text model's shape (google/gemini-4-neon, 2026-11-27) with its
    // token prices at 0: its image, audio and web-search prices still make it paid.
    const imagePriced = {
      id: "google/gemini-4-neon",
      architecture: { input_modalities: ["audio", "file", "image", "text", "video"], output_modalities: ["text"] },
      pricing: { prompt: "0", completion: "0", image: "0.000003", audio: "0.000003", input_audio_cache: "0.00000015", web_search: "0.014", internal_reasoning: "0", input_cache_read: "0", input_cache_write: "0" },
    };
    expect(isTrulyFreeTextModel(imagePriced)).toBe(false);
    expect(isTrulyFreeTextModel({ ...imagePriced, pricing: { prompt: "0", completion: "0", image: "0" } })).toBe(true);
    // A field the app does not know is a price, and so is any value but 0.
    expect(everyPriceZero({ prompt: "0", completion: "0", video_second: "0.01" })).toBe(false);
    expect(everyPriceZero({ prompt: "0", completion: "0", request: "" })).toBe(false);
    expect(everyPriceZero({ prompt: "0", completion: "0", overrides: [{ min_prompt_tokens: 1000, prompt: "0.000001" }] })).toBe(false);
    expect(everyPriceZero({ prompt: "0", completion: "0", overrides: [{ utc_days: ["monday"], utc_start: 0, utc_end: 100, prompt: "0", completion: "0" }] })).toBe(true);
    expect(everyPriceZero(undefined)).toBe(false);
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
    // The models list, then the endpoints list of each priced model with tool
    // use that is neither free nor a router, for its strength.
    expect(fetcher.sent[0]!.url).toBe("https://openrouter.ai/api/v1/models");
    expect(fetcher.sent.slice(1).map((s) => s.url).sort()).toEqual(TIERED_PAID.map((m) => `https://openrouter.ai/api/v1/models/${m}/endpoints`));
    // No key is sent to read the public lists.
    expect(fetcher.sent.every((s) => s.headers.authorization === undefined)).toBe(true);
    expect(results).toEqual([expect.objectContaining({ source: "openrouter-models", ok: true, unmapped: 4 })]);
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

describe("merging", () => {
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
    const html = renderPriceTablePage({ snapshot, rows, alerts: await recentAlerts(env.DB), sort: { column: "provider", dir: "asc" }, strength: await readStrength(env.DB, snapshot) });
    expect(html).toContain("OpenRouter models API: ok");
    expect(html).toContain("openai/gpt-6-luna");
    expect(html).toContain("openrouter.ai</a>, read 2026-11-27");
    expect(html).toContain("Free (:free) models, which a $0 account can use, allow 20 requests a minute");
    expect(html).not.toContain("does not offer");
    expect(html).not.toMatch(/Bedrock|Foundry|Vertex|maintainer-read/);
    expect(displayRows(rows).find((r) => r.model === "anthropic/claude-haiku-5.5")).toMatchObject({ input: 0.1, longInput: 0.5 });
  });
});
