import { describe, expect, it } from "vitest";
import maintainerFile from "../prices/maintainer-read.json";
import { checkMaintainerEntries, entriesDueForReading, type MaintainerEntry } from "../src/prices/maintainer";
import { mergeRows } from "../src/prices/refresh";
import { tierFromInputPrice } from "../src/prices/tiers";
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

  it("leaves agreeing rows unflagged", () => {
    const { rows, disagreements } = mergeRows([row(1.5, "maintainer-read"), row(1.5, "google-catalog")]);
    expect(rows[0]?.disagreement).toBe(false);
    expect(disagreements).toHaveLength(0);
  });
});
