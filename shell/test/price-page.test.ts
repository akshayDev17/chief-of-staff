import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import maintainerFile from "../prices/maintainer-read.json";
import worker from "../src/index";
import type { MaintainerEntry } from "../src/prices/maintainer";
import { displayRows, sortRows } from "../src/prices/page";
import { refreshPrices } from "../src/prices/refresh";
import { readSnapshotRows, writeSnapshot } from "../src/prices/store";
import type { PriceRow } from "../src/prices/types";
import { ENV, generateKey, serveCerts, signToken, type TestKey } from "./access-fixture";
import { fakeFetch } from "./fake-sources";
import azure from "./fixtures/azure-retail-eastus2.json";

let key: TestKey;
let stranger: TestKey;

beforeAll(async () => {
  key = await generateKey("kid-price-page");
  stranger = await generateKey("kid-price-page-stranger");
});

afterEach(() => vi.restoreAllMocks());

const PAGE = "https://shell.test/chief-of-staff/admin/price-table";

// Every request passes the Access check first, as in health.test.ts.
const page = async (query = "") => {
  serveCerts(() => [key]);
  const headers = { "cf-access-jwt-assertion": await signToken(key) };
  const response = await worker.fetch(new Request(`${PAGE}${query}`, { headers }), { ...ENV, DB: env.DB });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  return response.text();
};
const fill = async (googleApiKey: string | null = "test-key") =>
  refreshPrices({
    db: env.DB, fetcher: fakeFetch(), googleApiKey: googleApiKey ?? undefined,
    maintainerEntries: maintainerFile.entries as MaintainerEntry[], now: new Date("2026-11-24T06:00:00Z"),
  });

describe("Admin · Price table behind the Access check", () => {
  // A D1 that fails the test if the route touches it.
  const untouchedDb = new Proxy({}, {
    get() {
      throw new Error("the price table was read before the Access check passed");
    },
  }) as D1Database;

  it("answers 403 without a token, and reads nothing", async () => {
    serveCerts(() => [key]);
    const response = await worker.fetch(new Request(PAGE), { ...ENV, DB: untouchedDb });
    expect(response.status).toBe(403);
  });

  it("answers 403 for a token Access did not sign, and reads nothing", async () => {
    serveCerts(() => [key]);
    const headers = { "cf-access-jwt-assertion": await signToken(stranger) };
    const response = await worker.fetch(new Request(PAGE, { headers }), { ...ENV, DB: untouchedDb });
    expect(response.status).toBe(403);
  });
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

  it("shows how many rows each source added and dropped against the previous snapshot", async () => {
    await fill();
    const withoutLuna = () => Response.json({ ...azure, Items: azure.Items.filter((i) => !i.meterName.startsWith("6-luna")) });
    const { results } = await refreshPrices({
      db: env.DB, fetcher: fakeFetch({ azure: withoutLuna }), googleApiKey: "test-key",
      maintainerEntries: maintainerFile.entries as MaintainerEntry[], now: new Date("2026-11-25T06:00:00Z"),
    });
    const read = results.find((r) => r.source === "azure-retail")!;
    expect(read).toMatchObject({ ok: true, added: 0 });
    expect(read.dropped).toBeGreaterThan(0);
    const html = await page();
    expect(html).toContain(`Azure Retail Prices API, service Foundry Models: ok (${read.rows} rows, 0 added and ${read.dropped} dropped against the previous snapshot`);
  });

  it("gives every row of a model the model's one tier, from its Global input price", async () => {
    const row = (deployment: PriceRow["deployment"], region: string, usdPerMTok: number): PriceRow => ({
      provider: "bedrock", model: "Claude Test 1", deployment, region, tokenKind: "input", longPrompt: false, batch: false,
      usdPerMTok, source: "aws-price-list", dateRead: "2026-11-24", stale: false, disagreement: false,
    });
    // Bedrock's in-region price sits 10% above Global: $2.40 is Middle, $2.64 would be Strongest.
    await writeSnapshot(env.DB, {
      takenAt: "2026-11-24T06:00:00.000Z", status: "good", results: [],
      rows: [row("global", "us-east-1", 2.4), row("regional", "us-east-1", 2.64)],
    });
    const html = await page();
    const tiers = [...html.matchAll(/<td data-l="Strength \(from the input price\)">([^<]+)<\/td>/g)].map((m) => m[1]);
    expect(tiers).toEqual(["Middle", "Middle"]);
    expect(html).toContain("$2.64");
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

  it("offers every header order in the Sort by list, with the active one selected", async () => {
    const orders = ["provider", "model", "input", "output"].flatMap((c) => [`${c}:asc`, `${c}:desc`]);
    for (const order of orders) {
      const html = await page(`?sort=${order}`);
      const options = [...html.matchAll(/<option value="([^"]+)"( selected)?>/g)];
      expect(options.map((m) => m[1])).toEqual(expect.arrayContaining(orders));
      expect(options.filter((m) => m[2]).map((m) => m[1])).toEqual([order]);
    }
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
