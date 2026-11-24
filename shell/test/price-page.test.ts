import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import maintainerFile from "../prices/maintainer-read.json";
import type { MaintainerEntry } from "../src/prices/maintainer";
import { displayRows, sortRows } from "../src/prices/page";
import { refreshPrices } from "../src/prices/refresh";
import { readSnapshotRows } from "../src/prices/store";
import { fakeFetch } from "./fake-sources";

const page = async (query = "") => {
  const response = await SELF.fetch(`https://shell.test/admin/price-table${query}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  return response.text();
};
const fill = async (googleApiKey: string | null = "test-key") =>
  refreshPrices({
    db: env.DB, fetcher: fakeFetch(), googleApiKey: googleApiKey ?? undefined,
    maintainerEntries: maintainerFile.entries as MaintainerEntry[], now: new Date("2026-11-24T06:00:00Z"),
  });

describe("Admin · Price table", () => {
  it("says so before the first refresh", async () => {
    expect(await page()).toContain("No refresh yet.");
  });

  it("shows each row with its price, source, date read and strength, and the last refresh", async () => {
    await fill(null);
    const html = await page();
    expect(html).toContain("Last refresh 2026-11-24 06:00 UTC:");
    expect(html).toContain("Google Cloud Billing Catalog API, service Vertex AI: <strong>failed</strong>");
    expect(html).toMatch(/<td data-l="Model">Claude Sonnet 5\.5<\/td>\s*<td[^>]*><span[^>]*>global \(us-east-1\)<\/span><\/td>\s*<td data-l="Input \/ M">\$2\.00<\/td>\s*<td data-l="Output \/ M">\$10\.00<\/td>/);
    expect(html).toContain("Marketplace listing, read by the maintainers");
    expect(html).toContain("2026&#8209;11&#8209;24");
    expect(html).toContain(">Middle<");
    expect(html).toContain("Quotas, beside the table");
  });

  it("sorts by provider, then model, by default, with the arrow on Provider", async () => {
    await fill();
    const html = await page();
    expect(html).toContain('<th aria-sort="ascending"><a class="th-sort" href="?sort=provider:desc">Provider<span class="sort-arrow" aria-hidden="true">▲</span>');
    const providers = [...html.matchAll(/<td data-l="Provider">([^<]+)<\/td>/g)].map((m) => m[1]);
    const firstOf = (p: string) => providers.indexOf(p);
    expect(firstOf("Bedrock")).toBeLessThan(firstOf("Foundry"));
    expect(firstOf("Foundry")).toBeLessThan(firstOf("Vertex AI"));
  });

  it("sorts by input price, highest first, and offers the same choices in a Sort by list", async () => {
    await fill();
    const html = await page("?sort=input:desc");
    expect(html).toContain('<th aria-sort="descending"><a class="th-sort" href="?sort=input:asc">Input / M<span class="sort-arrow" aria-hidden="true">▼</span>');
    const inputs = [...html.matchAll(/<td data-l="Input \/ M">\$([\d.]+)<\/td>/g)].map((m) => Number(m[1]));
    expect(inputs).toEqual([...inputs].sort((a, b) => b - a));
    expect(html).toContain('<option value="input:desc" selected>Input price (highest first)</option>');
    // Region, strength, source and date do not sort.
    expect(html).toContain("<th>Region or deployment type</th>");
    expect(html).toContain("<th>Source</th>");
  });

  it("shows no price yet for a row without an input price, sorted last", async () => {
    const { snapshotId } = await fill();
    const rows = (await readSnapshotRows(env.DB, snapshotId)).filter((r) => !(r.model === "Gemini 3.8 Flash" && r.tokenKind === "input"));
    const sorted = sortRows(displayRows(rows), "input", "asc");
    const gemini = sorted.filter((r) => r.model === "Gemini 3.8 Flash");
    expect(gemini.every((r) => r.input === undefined)).toBe(true);
    expect(sorted.at(-1)?.input).toBeUndefined();
  });
});
