import { describe, expect, it } from "vitest";
import maintainerFile from "../prices/maintainer-read.json";
import { checkMaintainerEntries, entriesDueForReading, type MaintainerEntry } from "../src/prices/maintainer";
import { mergeRows } from "../src/prices/refresh";
import { modelTier, tierFromInputPrice } from "../src/prices/tiers";
import type { PriceRow } from "../src/prices/types";

describe("tiers from the input list price", () => {
  it("draws the bands at $0.50 and $2.50", () => {
    expect(tierFromInputPrice(0.1)).toBe("Smallest");
    expect(tierFromInputPrice(0.4999)).toBe("Smallest");
    expect(tierFromInputPrice(0.5)).toBe("Middle");
    expect(tierFromInputPrice(2.4999)).toBe("Middle");
    expect(tierFromInputPrice(2.5)).toBe("Strongest");
    expect(tierFromInputPrice(10)).toBe("Strongest");
  });
});

describe("one tier per model at each provider", () => {
  const input = (provider: PriceRow["provider"], deployment: PriceRow["deployment"], region: string, usdPerMTok: number, extra: Partial<PriceRow> = {}): PriceRow => ({
    provider, model: "Model X", deployment, region, tokenKind: "input", longPrompt: false, batch: false,
    usdPerMTok, source: "aws-price-list", dateRead: "2026-11-24", stale: false, disagreement: false, ...extra,
  });

  it("takes Bedrock's and Foundry's Global input price over a dearer in-region one", () => {
    expect(modelTier("bedrock", [input("bedrock", "regional", "us-east-1", 2.64), input("bedrock", "global", "us-east-1", 2.4)])).toBe("Middle");
    expect(modelTier("foundry", [input("foundry", "data-zone", "eastus2", 2.75), input("foundry", "global", "global", 2.5)])).toBe("Strongest");
  });

  it("falls to the next deployment type where a model has no Global price", () => {
    expect(modelTier("bedrock", [input("bedrock", "regional", "us-west-2", 3), input("bedrock", "cross-region", "us-east-1", 0.4)])).toBe("Smallest");
    expect(modelTier("foundry", [input("foundry", "regional", "eastus2", 0.6)])).toBe("Middle");
  });

  it("takes Vertex AI's regional price over its Global one, the highest region counting for now", () => {
    expect(modelTier("vertex", [input("vertex", "global", "global", 2.4), input("vertex", "regional", "us-east5", 2.4), input("vertex", "regional", "europe-west1", 2.64)])).toBe("Strongest");
    expect(modelTier("vertex", [input("vertex", "global", "global", 0.3)])).toBe("Smallest");
  });

  it("ignores long-prompt, batch and other token prices, and has no tier without a standard input price", () => {
    const rows = [
      input("bedrock", "global", "us-east-1", 6, { longPrompt: true }),
      input("bedrock", "global", "us-east-1", 6, { batch: true }),
      input("bedrock", "global", "us-east-1", 6, { tokenKind: "output" }),
    ];
    expect(modelTier("bedrock", rows)).toBeUndefined();
    expect(modelTier("bedrock", [...rows, input("bedrock", "global", "us-east-1", 0.2)])).toBe("Smallest");
  });
});

describe("the maintainer-read file", () => {
  it("is valid: every entry has its listing address and date read", () => {
    expect(checkMaintainerEntries(maintainerFile.entries)).toEqual([]);
    expect(maintainerFile.entries.length).toBeGreaterThan(0);
  });

  it("refuses an entry without its listing address or date read", () => {
    const good = maintainerFile.entries[0] as MaintainerEntry;
    const { listing: _l, ...noListing } = good;
    const { date_read: _d, ...noDate } = good;
    expect(checkMaintainerEntries([noListing])).toEqual([`entry 0 (${good.model}): no listing address`]);
    expect(checkMaintainerEntries([noDate])).toEqual([`entry 0 (${good.model}): no date read`]);
    expect(checkMaintainerEntries([{ ...good, date_read: "last week" }])).toHaveLength(1);
  });

  it("refuses an entry without a region, or with a deployment the table does not know", () => {
    const good = maintainerFile.entries[0] as MaintainerEntry;
    const { region: _r, ...noRegion } = good;
    const at = `entry 0 (${good.model})`;
    expect(checkMaintainerEntries([noRegion])).toEqual([`${at}: no region`]);
    expect(checkMaintainerEntries([{ ...good, region: "" }])).toEqual([`${at}: no region`]);
    expect(checkMaintainerEntries([{ ...good, deployment: "Global" }])).toEqual([`${at}: unknown deployment Global`]);
    const { deployment: _d, ...noDeployment } = good;
    expect(checkMaintainerEntries([noDeployment])).toEqual([`${at}: unknown deployment undefined`]);
  });

  it("refuses a meter without long_prompt true or false", () => {
    const good = maintainerFile.entries[0] as MaintainerEntry;
    const at = `entry 0 (${good.model})`;
    const input = { token_kind: "input", long_prompt: false, usd_per_mtok: 3 };
    const { long_prompt: _l, ...noLongPrompt } = input;
    expect(checkMaintainerEntries([{ ...good, meters: [noLongPrompt] }])).toEqual([`${at}: long_prompt is not true or false`]);
    expect(checkMaintainerEntries([{ ...good, meters: [{ ...input, long_prompt: "no" }] }])).toEqual([`${at}: long_prompt is not true or false`]);
  });

  it("finds readings more than a week old", () => {
    const e = { ...(maintainerFile.entries[0] as MaintainerEntry), date_read: "2026-11-16" };
    expect(entriesDueForReading([e], "2026-11-23")).toHaveLength(0);
    expect(entriesDueForReading([e], "2026-11-24")).toHaveLength(1);
  });
});

describe("two sources disagreeing", () => {
  const row = (usd: number, source: PriceRow["source"]): PriceRow => ({
    provider: "vertex", model: "Gemini 3.8 Flash", deployment: "global", region: "global", tokenKind: "input",
    longPrompt: false, batch: false, usdPerMTok: usd, source, dateRead: "2026-11-24", stale: false, disagreement: false,
  });

  it("keeps the higher price and flags the row", () => {
    const { rows, disagreements } = mergeRows([row(0.75, "maintainer-read"), row(1.5, "google-catalog")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ usdPerMTok: 1.5, source: "google-catalog", disagreement: true });
    expect(disagreements).toHaveLength(1);
  });

  it("names each disagreeing row once, however many listings give it", () => {
    const { rows, disagreements } = mergeRows([row(0.8, "aws-price-list"), row(3.26, "aws-price-list"), row(0.8, "aws-price-list")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ usdPerMTok: 3.26, disagreement: true });
    expect(disagreements).toEqual(["vertex Gemini 3.8 Flash global input: 0.8 vs 3.26"]);
  });

  it("leaves agreeing rows unflagged", () => {
    const { rows, disagreements } = mergeRows([row(1.5, "maintainer-read"), row(1.5, "google-catalog")]);
    expect(rows[0]?.disagreement).toBe(false);
    expect(disagreements).toHaveLength(0);
  });
});
