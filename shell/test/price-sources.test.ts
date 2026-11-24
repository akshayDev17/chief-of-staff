import { describe, expect, it } from "vitest";
import { parseAwsUsageType, rowsFromAwsOffer, type AwsOfferFile } from "../src/prices/aws";
import { parseAzureMeter, rowsFromAzureItems, type AzureRetailItem } from "../src/prices/azure";
import { parseGoogleDescription, rowsFromGoogleSkus, type GoogleSku } from "../src/prices/google";
import type { PriceRow } from "../src/prices/types";
import azure from "./fixtures/azure-retail-eastus2.json";
import awsBedrock from "./fixtures/aws-AmazonBedrock-us-east-1.json";
import awsFoundation from "./fixtures/aws-AmazonBedrockFoundationModels-us-east-1.json";
import google from "./fixtures/google-catalog-vertex.json";

const find = (rows: PriceRow[], q: Partial<PriceRow>) =>
  rows.filter((r) => Object.entries(q).every(([k, v]) => r[k as keyof PriceRow] === v));
const one = (rows: PriceRow[], q: Partial<PriceRow>) => {
  const hits = find(rows, q);
  expect(hits, JSON.stringify(q)).toHaveLength(1);
  return hits[0] as PriceRow;
};

describe("Azure Retail Prices API (saved response, eastus2, 2026-11-24)", () => {
  const { rows } = rowsFromAzureItems(azure.Items as AzureRetailItem[], "2026-11-24");
  const luna = { model: "GPT-6-luna", region: "eastus2", batch: false };

  it("reads every kind of token for GPT-6 Luna at Global", () => {
    const at = { ...luna, deployment: "global" as const, longPrompt: false };
    expect(one(rows, { ...at, tokenKind: "input" }).usdPerMTok).toBe(0.1);
    expect(one(rows, { ...at, tokenKind: "output" }).usdPerMTok).toBe(0.5);
    expect(one(rows, { ...at, tokenKind: "cached_input" }).usdPerMTok).toBe(0.01);
    expect(one(rows, { ...at, tokenKind: "cache_write" }).usdPerMTok).toBe(0.125);
  });

  it("keeps long-prompt and Data Zone prices apart", () => {
    expect(one(rows, { ...luna, deployment: "global", longPrompt: true, tokenKind: "input" }).usdPerMTok).toBe(0.2);
    expect(one(rows, { ...luna, deployment: "data-zone", longPrompt: false, tokenKind: "input" }).usdPerMTok).toBe(0.11);
  });

  it("leaves out flex meters, embeddings and meters it cannot name", () => {
    expect(find(rows, { model: "GPT-6-luna", usdPerMTok: 0.05 })).toHaveLength(0); // the Flex input price
    expect(rows.some((r) => /embed|ada|model 6/i.test(r.model))).toBe(false);
  });

  it("converts per-1K meters to per-1M", () => {
    expect(one(rows, { model: "Grok 4.7", deployment: "global", tokenKind: "input", longPrompt: false }).usdPerMTok).toBe(2);
  });

  it("parses the abbreviations Azure uses", () => {
    expect(parseAzureMeter("4.3 Cached Inp DZ L Tokens", "Azure Grok Models")).toEqual({
      model: "Grok 4.3", tokenKind: "cached_input", deployment: "data-zone", longPrompt: true, batch: false,
    });
    expect(parseAzureMeter("61sol ShCo Cd Wr Gl 1M Tokens", "Azure OpenAI GPT6")?.model).toBe("GPT-6.1-sol");
    expect(parseAzureMeter("gpt 4o mini0718 BatchOutp DataZone Tokens", "Azure OpenAI")).toMatchObject({ tokenKind: "output", batch: true, deployment: "data-zone" });
    expect(parseAzureMeter("Phi-4-mini-reasoning-Input Tokens", "Azure Phi Models")).toBeUndefined(); // no deployment type
    expect(parseAzureMeter("6-sol ShortCo Inp PP Gl 1M Tokens", "Azure OpenAI GPT6")).toBeUndefined(); // priority
  });
});

describe("AWS price-list files (saved, us-east-1, publication 2026-11-23)", () => {
  const foundation = rowsFromAwsOffer(awsFoundation as unknown as AwsOfferFile, "2026-11-24").rows;
  const bedrock = rowsFromAwsOffer(awsBedrock as unknown as AwsOfferFile, "2026-11-24").rows;
  const sonnet = { model: "Claude Sonnet 5.5", region: "us-east-1", longPrompt: false, batch: false };

  it("reads Claude Sonnet 5.5 global and in-region prices", () => {
    expect(one(foundation, { ...sonnet, deployment: "global", tokenKind: "input" }).usdPerMTok).toBe(2);
    expect(one(foundation, { ...sonnet, deployment: "global", tokenKind: "output" }).usdPerMTok).toBe(10);
    expect(one(foundation, { ...sonnet, deployment: "regional", tokenKind: "input" }).usdPerMTok).toBe(2.2);
    expect(one(foundation, { ...sonnet, deployment: "global", tokenKind: "cached_input" }).usdPerMTok).toBe(0.1);
    expect(one(foundation, { ...sonnet, deployment: "global", tokenKind: "cache_write" }).usdPerMTok).toBe(2.5);
    expect(one(foundation, { ...sonnet, deployment: "global", tokenKind: "cache_write_1h" }).usdPerMTok).toBe(4);
  });

  it("names OpenAI models without the vendor prefix and reads long-prompt prices", () => {
    expect(one(foundation, { model: "GPT-6 Luna", deployment: "global", tokenKind: "input", longPrompt: true, batch: false }).usdPerMTok).toBe(0.2);
  });

  it("reads gpt-oss from the AmazonBedrock offer, per-1K converted", () => {
    const input = find(bedrock, { model: "gpt-oss-120b", tokenKind: "input", batch: false, deployment: "regional" });
    expect(input.length).toBeGreaterThan(0);
    expect(input.every((r) => r.usdPerMTok > 0 && r.usdPerMTok < 1)).toBe(true);
  });

  it("reads Claude 2.0 and Instant at the Bedrock list price, leaving out the Marketplace 100K editions", () => {
    // Products as AWS lists them in AmazonBedrockFoundationModels us-east-1 (read 2026-11-25).
    const product = (sku: string, model: string, servicename: string, kind: "Input" | "Output", usd: string) => ({
      product: {
        sku,
        attributes: { model, servicename, regionCode: "us-east-1", inferenceType: `${kind} tokens`, usagetype: `USE1-MP:USE1_${kind}TokenCount-Units` },
      },
      term: { [`${sku}.T`]: { priceDimensions: { [`${sku}.T.D`]: { unit: "1M tokens", pricePerUnit: { USD: usd } } } } },
    });
    const listed = [
      product("A", "Claude 2.0", "Claude (Amazon Bedrock Edition)", "Input", "8.0000000000"),
      product("B", "Claude 2.0", "Claude (Amazon Bedrock Edition)", "Output", "24.0000000000"),
      product("C", "Claude 2.0", "Claude (100K) (Amazon Bedrock Edition)", "Input", "22.0400000000"),
      product("D", "Claude 2.0", "Claude (100K) (Amazon Bedrock Edition)", "Output", "65.3600000000"),
      product("E", "Claude Instant", "Claude Instant (Amazon Bedrock Edition)", "Input", "0.8000000000"),
      product("F", "Claude Instant", "Claude Instant (Amazon Bedrock Edition)", "Output", "2.4000000000"),
      product("G", "Claude Instant", "Claude Instant (100K) (Amazon Bedrock Edition)", "Input", "3.2600000000"),
      product("H", "Claude Instant", "Claude Instant (100K) (Amazon Bedrock Edition)", "Output", "11.0200000000"),
    ];
    const offer = {
      publicationDate: "2026-11-23",
      products: Object.fromEntries(listed.map((l) => [l.product.sku, l.product])),
      terms: { OnDemand: Object.fromEntries(listed.map((l) => [l.product.sku, l.term])) },
    } as AwsOfferFile;
    const rows = rowsFromAwsOffer(offer, "2026-11-25").rows;
    expect(rows.map((r) => [r.model, r.tokenKind, r.usdPerMTok])).toEqual([
      ["Claude 2.0", "input", 8],
      ["Claude 2.0", "output", 24],
      ["Claude Instant", "input", 0.8],
      ["Claude Instant", "output", 2.4],
    ]);
  });

  it("parses usage types, skipping flex and priority", () => {
    expect(parseAwsUsageType("USE1-MP:USE1_InputTokenCount_Batch-Units")).toEqual({ tokenKind: "input", deployment: "regional", longPrompt: false, batch: true });
    expect(parseAwsUsageType("USE1-MP:USE1_CacheWriteInputTokenCount_Global-Units")?.tokenKind).toBe("cache_write");
    expect(parseAwsUsageType("USE1-MP:USE1_CacheWrite1hInputTokenCount_Global-Units")?.tokenKind).toBe("cache_write_1h");
    expect(parseAwsUsageType("USE1-MP:USE1_cached_input_tokens_long_ctx_standard-Units")).toEqual({ tokenKind: "cached_input", deployment: "regional", longPrompt: true, batch: false });
    expect(parseAwsUsageType("USE1-xai.grok-4.7-mantle-input-tokens-priority")).toBeUndefined();
  });
});

describe("Google Cloud Billing Catalog API (response shaped from Google's format)", () => {
  const { rows } = rowsFromGoogleSkus(google.skus as GoogleSku[], "2026-11-24");

  it("converts per-token and per-million units to USD per 1M tokens", () => {
    expect(one(rows, { model: "Claude Sonnet 5.5", region: "global", tokenKind: "input" }).usdPerMTok).toBe(2);
    expect(one(rows, { model: "Claude Sonnet 5.5", region: "global", tokenKind: "output" }).usdPerMTok).toBe(10);
    expect(one(rows, { model: "Gemini 3.8 Flash", tokenKind: "input" }).usdPerMTok).toBe(1.5);
  });

  it("writes one row per region and marks batch", () => {
    expect(find(rows, { model: "Claude Sonnet 5.5", deployment: "regional", tokenKind: "input" }).map((r) => r.region).sort()).toEqual(["europe-west1", "us-east5"]);
    expect(one(rows, { model: "Gemini 3.8 Flash", tokenKind: "output" }).batch).toBe(true);
  });

  it("leaves out image input", () => {
    expect(parseGoogleDescription("Gemini 3.8 Flash Image Input - Predictions")).toBeUndefined();
    expect(rows).toHaveLength(6);
  });
});
