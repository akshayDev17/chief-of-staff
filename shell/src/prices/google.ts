// Reads Vertex AI's chat-model prices from Google's Cloud Billing Catalog API
// (services.skus.list on the Vertex AI service), with the maintainers' API key
// from the Worker secret GOOGLE_BILLING_API_KEY. The key arrives with T10;
// until then this source reports a failure and the table keeps what it has.
//
// A Sku's description names the model and the token kind, for example
// "Claude Sonnet 5.5 Input Tokens" or "Gemini 3.8 Flash Batch Text Output";
// its pricingExpression gives the price per usage unit, and serviceRegions the
// regions. The shape follows Google's reference page (see sources.ts).

import { round } from "./azure";
import { GOOGLE_CATALOG_BASE, GOOGLE_VERTEX_SERVICE } from "./sources";
import type { Deployment, PriceRow, SourceRead, TokenKind } from "./types";

interface Money {
  currencyCode: string;
  units: string;
  nanos: number;
}

export interface GoogleSku {
  skuId: string;
  description: string;
  category: { serviceDisplayName: string; resourceFamily: string; resourceGroup: string; usageType: string };
  serviceRegions: string[];
  pricingInfo: Array<{
    pricingExpression: {
      usageUnit: string;
      tieredRates: Array<{ startUsageAmount: number; unitPrice: Money }>;
    };
  }>;
}

const SKIP = /image|audio|video|tuning|tuned|training|embedding|grounding|search|priority|flex|provisioned|characters|online prediction|node|grpc|cyber/i;

// Tokens in one usage unit.
const TOKENS_PER_UNIT: Record<string, number> = { count: 1, "k{count}": 1e3, "M{count}": 1e6 };

export interface ParsedSku {
  model: string;
  tokenKind: TokenKind;
  longPrompt: boolean;
  batch: boolean;
}

export function parseGoogleDescription(description: string): ParsedSku | undefined {
  const d = description.replace(/\s+/g, " ").trim();
  if (SKIP.test(d) || !/\b(input|output)\b/i.test(d)) return undefined;
  let tokenKind: TokenKind;
  if (/cache (write|creation)/i.test(d)) tokenKind = /\b1h\b|1 hour/i.test(d) ? "cache_write_1h" : "cache_write";
  else if (/cache(d)?( read| hit)?/i.test(d)) tokenKind = "cached_input";
  else if (/\binput\b/i.test(d)) tokenKind = "input";
  else tokenKind = "output";
  const model = d
    .replace(/\b(long context|long|>\s*\d+k|\d+k\+?|batch|text|tokens?|input|output|cached?|cache|read|hit|write|creation|1h|5m|predictions?|for|and|on|vertex ai|global|regional)\b/gi, " ")
    .replace(/[-–(),:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!model) return undefined;
  return { model, tokenKind, longPrompt: /long|>\s*\d+k/i.test(d), batch: /\bbatch\b/i.test(d) };
}

export function rowsFromGoogleSkus(skus: GoogleSku[], dateRead: string): { rows: PriceRow[]; unmapped: number } {
  const rows: PriceRow[] = [];
  let unmapped = 0;
  for (const sku of skus) {
    const parsed = parseGoogleDescription(sku.description);
    const expression = sku.pricingInfo[0]?.pricingExpression;
    const tokens = expression ? TOKENS_PER_UNIT[expression.usageUnit] : undefined;
    if (!parsed || !expression || !tokens) {
      if (/tokens?|input|output/i.test(sku.description) && !SKIP.test(sku.description)) unmapped++;
      continue;
    }
    // Tiered rates: never count less than the vendor can charge.
    const perUnit = Math.max(...expression.tieredRates.map((t) => Number(t.unitPrice.units) + t.unitPrice.nanos / 1e9));
    for (const region of sku.serviceRegions) {
      const deployment: Deployment = region === "global" ? "global" : "regional";
      rows.push({
        provider: "vertex",
        ...parsed,
        deployment,
        region,
        usdPerMTok: round((perUnit * 1e6) / tokens),
        source: "google-catalog",
        dateRead,
        stale: false,
        disagreement: false,
      });
    }
  }
  return { rows, unmapped };
}

export async function readGoogle(fetcher: typeof fetch, apiKey: string | undefined, dateRead: string): Promise<SourceRead> {
  try {
    if (!apiKey) throw new Error("no Cloud Billing API key yet (GOOGLE_BILLING_API_KEY arrives with T10)");
    const skus: GoogleSku[] = [];
    let pageToken = "";
    for (let page = 0; page < 200; page++) {
      const url = new URL(`${GOOGLE_CATALOG_BASE}/services/${GOOGLE_VERTEX_SERVICE}/skus`);
      url.searchParams.set("key", apiKey);
      url.searchParams.set("currencyCode", "USD");
      url.searchParams.set("pageSize", "5000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await fetcher(url.toString());
      if (!response.ok) throw new Error(`Cloud Billing Catalog API answered ${response.status}`);
      const body = (await response.json()) as { skus?: GoogleSku[]; nextPageToken?: string };
      skus.push(...(body.skus ?? []));
      pageToken = body.nextPageToken ?? "";
      if (!pageToken) break;
    }
    const { rows, unmapped } = rowsFromGoogleSkus(skus, dateRead);
    if (rows.length === 0) throw new Error("Cloud Billing Catalog API returned no chat-model prices");
    return { source: "google-catalog", ok: true, rows, unmapped };
  } catch (error) {
    return { source: "google-catalog", ok: false, error: String(error instanceof Error ? error.message : error) };
  }
}
