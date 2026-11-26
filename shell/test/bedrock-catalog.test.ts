// Bedrock's own model list matched to the price table (T17). The fixtures are
// the owner's live us-east-1 listing of 2026-11-26 (account ID left out) and
// the price names the 2026-11-23 us-east-1 price-list files give, so this is
// also the check that the reviewed file (src/providers/bedrock-models.json)
// still fits them: an entry that no longer matches fails here.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hasLongPromptRule } from "../src/providers/anthropic";
import { bedrockPlugin, hasThirtyMinuteCache, usageFromConverse } from "../src/providers/bedrock";
import {
  catalogFromReplies,
  matchBedrockModels,
  readBedrockCatalog,
  readBedrockOffer,
  REVIEWED,
  type BedrockCatalog,
  type ModelOffer,
  type PricedName,
} from "../src/providers/bedrock-catalog";
import { refreshPrices } from "../src/prices/refresh";
import { currentSnapshot, readStoredBedrockCatalog, recentAlerts, writeSnapshot } from "../src/prices/store";
import type { PriceRow } from "../src/prices/types";
import maintainerFile from "../prices/maintainer-read.json";
import type { MaintainerEntry } from "../src/prices/maintainer";
import { awsEnv, fakeFetch, googleEnv } from "./fake-sources";
import models from "./fixtures/bedrock-foundation-models-us-east-1.json";
import priceNames from "./fixtures/bedrock-price-names-us-east-1.json";
import profiles from "./fixtures/bedrock-inference-profiles-us-east-1.json";

const catalog: BedrockCatalog = catalogFromReplies("us-east-1", "2026-11-26T14:44:00.000Z", models, [profiles]);
const priced: PricedName[] = priceNames.names.map((n) => ({
  name: n.name,
  deployments: n.deployments.map((d) => (d === "global" ? "global" : "regional")),
  longPrompt: n.longPrompt,
}));
const offer = matchBedrockModels({ catalog, priced });
const byKind = (kind: ModelOffer["kind"]) => Object.entries(offer.byName).filter(([, o]) => o.kind === kind).map(([name]) => name).sort();
const callable = (name: string) => {
  const o = offer.byName[name];
  if (o?.kind !== "callable") throw new Error(`${name} is ${o?.kind}`);
  return o;
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

describe("the reviewed file against the saved listing and price list", () => {
  it("names, for each entry, a priced name the rule misses and a model Bedrock lists", () => {
    const names = new Set(priceNames.names.map((n) => n.name));
    const ids = Object.values(REVIEWED.names);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [name, id] of Object.entries(REVIEWED.names)) {
      expect(names, name).toContain(name);
      expect(catalog.models.map((m) => m.modelId), id).toContain(id);
      expect(catalog.models.some((m) => same(m.modelName, name) || same(m.modelId, name)), `${name} needs no entry`).toBe(false);
    }
  });

  it("gives each priced Bedrock model ID to one name only", () => {
    const ids = Object.values(offer.byName).flatMap((o) => (o.kind === "callable" ? [o.modelId] : []));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("marks no-tool-use models that Bedrock lists", () => {
    for (const { prefix } of REVIEWED.noToolUse) expect(catalog.models.some((m) => m.modelId.startsWith(prefix)), prefix).toBe(true);
  });

  it("knows each long-prompt and 30-minute-cache rule the price list carries, and none it does not", () => {
    for (const n of priceNames.names) {
      const o = offer.byName[n.name];
      if (o?.kind !== "callable") continue;
      expect(hasThirtyMinuteCache(o.modelId), `${n.name} 30-minute cache`).toBe(n.cache30m);
      if (n.longPrompt) expect(hasLongPromptRule(o.modelId), `${n.name} long prompts`).toBe(true);
    }
  });
});

describe("matching the price table to Bedrock's own list", () => {
  it("offers every chat model of every family that Bedrock lists at a price", () => {
    expect(byKind("callable")).toEqual([
      "Claude Fable 5", "Claude Fable 5.1", "Claude Fable 5.2", "Claude Haiku 4.5", "Claude Haiku 5.5", "Claude Opus 4.5", "Claude Opus 4.6",
      "Claude Opus 4.7", "Claude Opus 4.8", "Claude Opus 5", "Claude Opus 5.5", "Claude Sonnet 4.6", "Claude Sonnet 5", "Claude Sonnet 5.5",
      "DeepSeek v3.2", "Devstral", "GLM 4.7", "GLM 4.7 Flash", "GLM 5", "GPT OSS Safeguard 120B", "GPT OSS Safeguard 20B", "GPT-5.4", "GPT-5.5",
      "GPT-5.6 Luna", "GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-6 Astra", "GPT-6 Luna", "GPT-6 Sol", "GPT-6.1 Sol", "GPT-6.1 Terra", "GPT-6.2 Astra",
      "GPT-6.2 Sol", "Gemma 3 12B", "Gemma 3 27B", "Gemma 3 4B", "Grok 4.7", "Kimi K2 Thinking", "Kimi K2.5", "Kimi K3", "Magistral Small 1.2",
      "MiniMax M2.5", "Minimax M2", "Minimax M2.1", "Ministral 14B 3.0", "Ministral 3B 3.0", "Ministral 8B 3.0", "Mistral Large", "Mistral Large 3",
      "Mistral Small", "NVIDIA Nemotron 3 Super 120B A12B", "NVIDIA Nemotron Nano 2", "NVIDIA Nemotron Nano 2 VL", "Nemotron Nano 3 30B",
      "Nova 2.0 Lite", "Nova Lite", "Nova Micro", "Nova Pro", "Pixtral Large 25.02", "Qwen3 32B", "Qwen3 Coder 30B A3B", "Qwen3 Coder Next",
      "Qwen3 Next 80B A3B", "Qwen3 VL 235B A22B", "Voxtral Mini 1.0", "Voxtral Small 1.0", "Writer Palmyra Vision 7B", "gpt-oss-120b",
      "gpt-oss-20b", "xai.grok-4.6",
    ]);
  });

  it("drops the models Bedrock marks LEGACY", () => {
    expect(byKind("dropped")).toEqual([
      "Claude Opus 4.1", "Claude Sonnet 4.5", "Llama 3 70B", "Llama 3 8B", "Llama 3.1 70B", "Llama 3.1 8B", "Llama 3.3 70B",
      "Llama 4 Maverick 17B", "Llama 4 Scout 17B", "Mistral 7B", "Mixtral 8x7B", "Palmyra X4", "Palmyra X5", "R1",
    ]);
  });

  it("says why each other priced name is not offered", () => {
    const notOffered = byKind("not_offered");
    expect(notOffered).toEqual([
      "Claude 2.0", "Claude 2.1", "Claude 3 Haiku", "Claude 3 Opus", "Claude 3 Sonnet", "Claude 3.5 Haiku", "Claude 3.5 Sonnet",
      "Claude 3.5 Sonnet v2", "Claude 3.7 Sonnet", "Claude Instant", "Claude Mythos 5", "Claude Mythos 5.1", "Claude Mythos 5.2",
      "Claude Mythos Preview", "Claude Opus 4", "Claude Sonnet 4", "Command", "Command R", "Command R+", "Command-Light", "DeepSeek V3.1",
      "GPT-Daybreak-5.6-Sol", "GPT-Daybreak-Red-5.6-Sol", "Jamba 1.5 Large", "Jamba 1.5 Mini", "Jamba-Instruct", "Jurassic Mid", "Jurassic Ultra",
      "Llama 3.2 11B", "Llama 3.2 1B", "Llama 3.2 3B", "Llama 3.2 90B", "Llama2-13B", "Llama2-70B", "Nova 2.0 Omni", "Nova 2.0 Pro", "Nova Premier",
      "Qwen3 235B A22B 2507", "Qwen3 Coder 480B A35B", "google.gemma-4-26b-a4b", "google.gemma-4-31b", "google.gemma-4-e2b", "xai.grok-4.3",
    ]);
    expect(offer.byName["Claude 3 Haiku"]).toEqual({ kind: "not_offered", reason: "Bedrock's own model list (us-east-1) has no model of this name", pricedAt: ["us-east-1"] });
  });

  it("calls each model where Bedrock offers it and the price table prices it: Global first, then the region", () => {
    expect(callable("Nova 2.0 Lite").locations).toEqual([
      { location: "global", callId: "global.amazon.nova-2-lite-v1:0", kind: "global" },
      { location: "us-east-1", callId: "us.amazon.nova-2-lite-v1:0", kind: "us" },
    ]);
    // On demand in the region, its own ID; no profile.
    expect(callable("Qwen3 32B").locations).toEqual([{ location: "us-east-1", callId: "qwen.qwen3-32b-v1:0", kind: "in-region" }]);
    // A Global profile exists, but the price list prices it in the region only.
    expect(callable("Nova Micro").locations).toEqual([{ location: "us-east-1", callId: "amazon.nova-micro-v1:0", kind: "in-region" }]);
    // Profile only: the geography profile Bedrock names from us-east-1.
    expect(callable("GPT-5.5").locations).toEqual([{ location: "us-east-1", callId: "us.openai.gpt-5.5", kind: "us" }]);
    expect(callable("GPT-6 Luna").locations.map((l) => l.callId)).toEqual(["global.openai.gpt-6-luna", "us.openai.gpt-6-luna"]);
  });

  it("marks the models that made no tool call, and no others", () => {
    const noTools = Object.entries(offer.byName).filter(([, o]) => o.kind === "callable" && o.noToolUse).map(([name]) => name).sort();
    expect(noTools).toEqual([
      "Gemma 3 12B", "Gemma 3 27B", "Gemma 3 4B", "NVIDIA Nemotron 3 Super 120B A12B", "NVIDIA Nemotron Nano 2", "NVIDIA Nemotron Nano 2 VL", "Nemotron Nano 3 30B",
    ]);
  });

  it("refuses a model priced by prompt length whose rule the app does not know, rather than count it low", () => {
    const o = matchBedrockModels({ catalog, priced: [{ name: "Qwen3 32B", deployments: ["regional"], longPrompt: true }] });
    expect(o.byName["Qwen3 32B"]).toEqual({ kind: "not_offered", reason: "the app does not know yet at what prompt length its long-prompt prices start, so it could count its cost too low", pricedAt: ["us-east-1"] });
  });

  it("refuses a reviewed name whose model ID Bedrock no longer lists, and a provisioned-only model", () => {
    const smaller: BedrockCatalog = { ...catalog, models: catalog.models.filter((m) => m.modelId !== "qwen.qwen3-32b-v1:0") };
    expect(matchBedrockModels({ catalog: smaller, priced: [{ name: "Qwen3 32B", deployments: ["regional"], longPrompt: false }] }).byName["Qwen3 32B"])
      .toMatchObject({ kind: "not_offered", reason: expect.stringContaining("no longer has the model ID") });
    const provisioned: BedrockCatalog = {
      ...catalog,
      models: catalog.models.map((m) => (m.modelId === "qwen.qwen3-32b-v1:0" ? { ...m, inferenceTypesSupported: ["ON_DEMAND"] } : m)),
      profiles: [],
    };
    expect(matchBedrockModels({ catalog: provisioned, priced: [{ name: "Qwen3 32B", deployments: ["global"], longPrompt: false }] }).byName["Qwen3 32B"])
      .toMatchObject({ kind: "callable", locations: [{ location: "us-east-1", callId: "qwen.qwen3-32b-v1:0" }] });
  });
});

describe("the Bedrock plug-in with the list", () => {
  const plugin = bedrockPlugin({}, fetch, () => new Date(), offer);
  const c = plugin.connect;

  it("can call every matched model, at the list's IDs, and says why not for the rest", () => {
    expect(c.canCall("Qwen3 32B")).toBe(true);
    expect(c.modelId("Qwen3 32B", "us-east-1")).toBe("qwen.qwen3-32b-v1:0");
    expect(c.modelId("GPT-6 Luna", "global")).toBe("global.openai.gpt-6-luna");
    expect(c.locations("GPT-5.5")).toEqual(["us-east-1"]);
    expect(c.locationLabel("us-east-1", "Qwen3 32B")).toBe("us-east-1 in-Region");
    expect(c.locationLabel("us-east-1", "GPT-5.5")).toBe("US cross-Region from us-east-1");
    expect(c.canCall("Claude 3 Haiku")).toBe(false);
    expect(c.notCallableReason("Claude 3 Haiku")).toBe("Bedrock's own model list (us-east-1) has no model of this name");
    // Its row still shows its list price, where the table has it.
    expect(c.locations("Claude 3 Haiku")).toEqual(["us-east-1"]);
    expect(c.listed!("Llama 3.3 70B")).toBe(false);
    expect(c.listed!("Claude 3 Haiku")).toBe(true);
    expect(c.noToolUse!("Gemma 3 4B")).toBe("tested live on Gemma 3 4B (google.gemma-3-4b-it): no tool call");
    expect(c.noToolUse!("Nemotron Nano 3 30B")).toBe("tested live on Nemotron Nano 2 9B (nvidia.nemotron-nano-9b-v2): no tool call");
    expect(c.noToolUse!("Qwen3 32B")).toBeUndefined();
  });

  it("honours the list's verdict on a built-in model: one marked LEGACY is not listed and cannot be called", () => {
    const legacy: BedrockCatalog = { ...catalog, models: catalog.models.map((m) => (m.modelId === "anthropic.claude-haiku-5-5" ? { ...m, lifecycle: "LEGACY" } : m)) };
    const lc = bedrockPlugin({}, fetch, () => new Date(), matchBedrockModels({ catalog: legacy, priced })).connect;
    expect(lc.listed!("Claude Haiku 5.5")).toBe(false);
    expect(lc.canCall("Claude Haiku 5.5")).toBe(false);
    expect(lc.notCallableReason("Claude Haiku 5.5")).toBe("Bedrock's own model list marks it legacy, or no longer as a chat model");
  });

  it("honours the list's long-prompt refusal on a built-in model, rather than count it low", () => {
    const o = matchBedrockModels({ catalog, priced: [{ name: "Claude Sonnet 5.5", deployments: ["global", "regional"], longPrompt: true }] });
    const lc = bedrockPlugin({}, fetch, () => new Date(), o).connect;
    expect(lc.canCall("Claude Sonnet 5.5")).toBe(false);
    expect(lc.notCallableReason("Claude Sonnet 5.5")).toContain("long-prompt prices");
  });

  it("before the list is read, offers only its built-in models, and says why", () => {
    const bare = bedrockPlugin({}).connect;
    expect(bare.canCall("Nova 2.0 Lite")).toBe(true);
    expect(bare.locations("Nova 2.0 Lite")).toEqual(["global", "us-east-1"]);
    expect(bare.canCall("Qwen3 32B")).toBe(false);
    expect(bare.notCallableReason("Qwen3 32B")).toBe("the app has not read Bedrock's own model list yet (Admin's one-time AWS step)");
  });
});

describe("Converse usage, by family", () => {
  it("costs a 30-minute cache write at the cache-write row only where the price list sells one", () => {
    const body = { usage: { inputTokens: 10, outputTokens: 2, cacheWriteInputTokens: 2000, cacheDetails: [{ ttl: "30m", inputTokens: 2000 }] } };
    expect(usageFromConverse(body, "global.openai.gpt-6-luna")).toMatchObject({ cacheWrite: 2000, cacheWrite1h: 0 });
    expect(usageFromConverse(body, "us.anthropic.claude-sonnet-5-5")).toMatchObject({ cacheWrite: 0, cacheWrite1h: 2000 });
  });

  it("bills a GPT prompt over 272,000 tokens, cached input included, at its long-prompt rows", () => {
    expect(usageFromConverse({ usage: { inputTokens: 200_000, cacheReadInputTokens: 72_001, outputTokens: 5 } }, "us.openai.gpt-5.5")?.longPrompt).toBe(true);
    expect(usageFromConverse({ usage: { inputTokens: 272_000, outputTokens: 5 } }, "global.openai.gpt-6-luna")?.longPrompt).toBe(false);
    expect(usageFromConverse({ usage: { inputTokens: 300_000, outputTokens: 5 } }, "openai.gpt-oss-120b-1:0")?.longPrompt).toBe(false);
  });

  it("counts reasoning as output, and any total above the counts given too", () => {
    // gpt-oss-20b, owner's check 2026-11-27: 74 in, 5 out, reasoning only.
    expect(usageFromConverse({ usage: { inputTokens: 74, outputTokens: 5, totalTokens: 79 } }, "openai.gpt-oss-20b-1:0")).toMatchObject({ input: 74, output: 5 });
    expect(usageFromConverse({ usage: { inputTokens: 74, outputTokens: 5, totalTokens: 90 } }, "openai.gpt-oss-20b-1:0")).toMatchObject({ input: 74, output: 16 });
  });

  it("passes a test call that answered with reasoning only, and shows no words for it", () => {
    const body = { output: { message: { content: [{ reasoningContent: { reasoningText: { text: "The user wants OK" } } }] } }, stopReason: "max_tokens" };
    expect(bedrockPlugin({}).connect.replyText(body)).toBeUndefined();
  });
});

describe("reading and keeping the list", () => {
  const entries = maintainerFile.entries as MaintainerEntry[];
  const refresh = async (day: string, fetcher = fakeFetch()) =>
    refreshPrices({ db: env.DB, fetcher, google: await googleEnv(), aws: await awsEnv(), maintainerEntries: entries, now: new Date(`${day}T06:00:00Z`) });

  it("reads both lists with the app's own role, signed for Bedrock in the app's region", async () => {
    const read = await readBedrockCatalog(fakeFetch(), await awsEnv(), "us-east-1", new Date("2026-11-27T06:00:00Z"));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.catalog.models.length).toBe(models.modelSummaries.length);
    expect(read.catalog.profiles.find((p) => p.id === "us.amazon.nova-2-lite-v1:0")?.models).toContainEqual({ region: "us-east-1", modelId: "amazon.nova-2-lite-v1:0" });
  });

  it("stores the list with the snapshot, and the request-time offer matches it to the table", async () => {
    await refresh("2026-11-27");
    const snapshot = (await currentSnapshot(env.DB))!;
    expect((await readStoredBedrockCatalog(env.DB, snapshot.id))?.readAt).toBe("2026-11-27T06:00:00.000Z");
    const read = (await readBedrockOffer(env.DB, "us-east-1"))!;
    // The trimmed price fixture holds Claude Sonnet 5.5 at us-east-1 and Global.
    expect(read.byName["Claude Sonnet 5.5"]).toMatchObject({ kind: "callable", modelId: "anthropic.claude-sonnet-5-5" });
    expect(await readBedrockOffer(env.DB, "eu-west-1")).toBeUndefined();
  });

  it("keeps the last list when the role cannot read it, and tells the owner which step it needs", async () => {
    await refresh("2026-11-27");
    const denied = () => new Response(JSON.stringify({ message: "User is not authorized to perform: bedrock:ListFoundationModels" }), { status: 403, headers: { "x-amzn-errortype": "AccessDeniedException:http://internal.amazon.com/coral/com.amazon.coral.service/" } });
    await refresh("2026-11-28", fakeFetch({ bedrockList: denied }));
    const snapshot = (await currentSnapshot(env.DB))!;
    expect((await readStoredBedrockCatalog(env.DB, snapshot.id))?.readAt).toBe("2026-11-27T06:00:00.000Z");
    const alert = (await recentAlerts(env.DB)).find((a) => a.detail.startsWith("bedrock-model-list"));
    expect(alert?.kind).toBe("refresh_failed");
    expect(alert?.detail).toContain("403 AccessDeniedException: User is not authorized to perform: bedrock:ListFoundationModels");
    expect(alert?.detail).toContain("bedrock:ListFoundationModels and bedrock:ListInferenceProfiles");
  });

  it("has no list, and offers the built-in models, until the first read", async () => {
    const row = (model: string, tokenKind: PriceRow["tokenKind"]): PriceRow => ({
      provider: "bedrock", model, deployment: "global", region: "us-east-1", tokenKind, longPrompt: false, batch: false, usdPerMTok: 1,
      source: "aws-price-list", dateRead: "2026-11-27", stale: false, disagreement: false,
    });
    await writeSnapshot(env.DB, { takenAt: "2026-11-27T06:00:00Z", status: "good", results: [], rows: [row("Nova 2.0 Lite", "input"), row("Nova 2.0 Lite", "output")] });
    expect(await readBedrockOffer(env.DB, "us-east-1")).toBeUndefined();
  });
});
