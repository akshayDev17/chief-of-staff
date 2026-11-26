// Reads Vertex AI's chat-model prices from Google's Cloud Billing Catalog API
// (services.skus.list on the Vertex AI service) with no key: a federated
// access token, about an hour long, for the price reader's own subject in the
// app's Workload Identity Federation pool (src/google-federation.ts), the
// same keyless route the Vertex AI calls take. The app's own project, the one
// holding the pool, is named as the quota project (`x-goog-user-project`),
// never a user's project; the price reader holds only the role that lets it
// name that project (README "What the owner sets up"). Until the pool exists
// (T10) this source reports a failure and the table keeps what it has.
//
// Google's pages (read 2026-11-26) do not settle whether the Catalog takes a
// federated token. Against: the how-to says "Calling the Cloud Billing
// Catalog API requires an API Key" (docs.cloud.google.com/billing/v1/how-tos/catalog-api).
// For: services.skus.list "Requires one of the following OAuth scopes"
// (cloud-platform, cloud-billing, cloud-billing.readonly), and Identity
// federation's products page lists Cloud Billing as GA, "Google Cloud API: No
// known limitations" (docs.cloud.google.com/iam/docs/federated-identity-supported-services).
// On quota: "Requests can fail if you make a request to a client-based API
// and the quota project cannot be identified", and the page names no quota
// project for a workload pool's own token, so the header is always sent; it
// needs "serviceusage.services.use" on the project
// (docs.cloud.google.com/docs/quotas/set-quota-project,
// docs.cloud.google.com/apis/docs/system-parameters). Whether this route works
// is checked live in M2 (design-v3 1.6, item 9). If Google refuses it, the
// owner is told; there is no fallback to an API key.
//
// A Sku's description names the model and the token kind, for example
// "Claude Sonnet 5.5 Input Tokens" or "Gemini 3.8 Flash Batch Text Output";
// its pricingExpression gives the price per usage unit, and serviceRegions the
// regions. The shape follows Google's reference page (see sources.ts).

import { appProjectNumber, priceReaderGoogleToken, type GoogleFederationEnv } from "../google-federation";
import { errorFromBody, readBody } from "../providers/anthropic";
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

export async function readGoogle(fetcher: typeof fetch, google: GoogleFederationEnv, now: Date, dateRead: string): Promise<SourceRead> {
  try {
    const { accessToken } = await priceReaderGoogleToken(google, fetcher, now);
    const headers = { authorization: `Bearer ${accessToken}`, "x-goog-user-project": appProjectNumber(google.GOOGLE_WIF_PROVIDER)! };
    const skus: GoogleSku[] = [];
    let pageToken = "";
    for (let page = 0; page < 200; page++) {
      const url = new URL(`${GOOGLE_CATALOG_BASE}/services/${GOOGLE_VERTEX_SERVICE}/skus`);
      url.searchParams.set("currencyCode", "USD");
      url.searchParams.set("pageSize", "5000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await fetcher(url.toString(), { headers });
      if (!response.ok) {
        // Google's own words, so a refusal at M2's check says why.
        const { name, message } = errorFromBody(response.status, await readBody(response));
        throw new Error(`Cloud Billing Catalog API answered ${response.status} ${name}${message ? `: ${message}` : ""}`);
      }
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
