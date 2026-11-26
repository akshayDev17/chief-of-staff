// Reads Bedrock's chat-model prices from AWS's public price-list files
// (offers AmazonBedrockFoundationModels and AmazonBedrock, plain HTTPS, no
// account; the Price List Query API, which needs IAM credentials, is not used).
//
// Each product carries its model, and its usagetype says the token kind and
// modifiers, for example "USE1-MP:USE1_input_tokens_long_ctx_global_standard-Units"
// or "USE1-deepseek.v3.2-mantle-input-tokens-batch". Its On-Demand term holds
// the price per 1M or 1K tokens.

import { round } from "./azure";
import { AWS_OFFERS, AWS_PRICING_BASE } from "./sources";
import type { Deployment, PriceRow, SourceRead, TokenKind } from "./types";

interface AwsProduct {
  sku: string;
  attributes: { model?: string | null; inferenceType?: string | null; usagetype?: string; regionCode?: string; servicename?: string };
}

interface AwsPriceDimension {
  unit: string;
  pricePerUnit: { USD?: string };
}

export interface AwsOfferFile {
  publicationDate: string;
  products: Record<string, AwsProduct>;
  terms: { OnDemand?: Record<string, Record<string, { priceDimensions: Record<string, AwsPriceDimension> }>> };
}

// Not chat inference at an on-demand list price.
const SKIP = /image|video|audio|embed|provisioned|modelunits|model_units|ultrafast|flex|priority|latency|reserved|tpm|custom|speech|training/i;
const NOT_CHAT_MODEL = /embed|rerank|marengo|canvas|reel|sonic|stability|sd3|titan|pegasus|^si-/i;
// The legacy AWS Marketplace "100K" editions of Claude 2.0 and Claude Instant
// ("Claude (100K) (Amazon Bedrock Edition)", "Claude Instant (100K) (Amazon
// Bedrock Edition)") share the on-demand usagetype and model name of the
// Bedrock listings but price a different Marketplace product ($22.04 / $65.36
// and $3.26 / $11.02 per 1M tokens in us-east-1 and us-west-2, against Bedrock's
// $8 / $24 and $0.80 / $2.40). They are not Bedrock on-demand prices.
const NOT_BEDROCK_EDITION = /\(100K\)/i;

export interface ParsedUsage {
  tokenKind: TokenKind;
  deployment: Deployment;
  longPrompt: boolean;
  batch: boolean;
}

export function parseAwsUsageType(usagetype: string): ParsedUsage | undefined {
  const u = usagetype.toLowerCase();
  if (SKIP.test(u)) return undefined;
  let tokenKind: TokenKind | undefined;
  if (/cache[_-]?read|cached[_-]?input/.test(u)) tokenKind = "cached_input";
  // A model's one short-lived cache write is `cache_write`: 5 minutes on
  // Claude and Nova, 30 minutes ("cache_write_tokens_30m") on the GPT-5.6 and
  // GPT-6 models and Kimi K3, which list no other (src/providers/bedrock.ts).
  else if (/cache[_-]?write/.test(u)) tokenKind = /write[_-]?1h|[_-]1h([_-]|$)/.test(u) ? "cache_write_1h" : "cache_write";
  else if (/input[_-]?tokens?/.test(u)) tokenKind = "input";
  else if (/output[_-]?tokens?/.test(u)) tokenKind = "output";
  if (!tokenKind) return undefined;
  const deployment: Deployment = /global/.test(u) ? "global" : /cross-region|[_-]geo([_-]|$)/.test(u) ? "cross-region" : "regional";
  return { tokenKind, deployment, longPrompt: /long[_-]?ctx/.test(u), batch: /batch/.test(u) };
}

const PER_UNIT: Record<string, number> = { "1m tokens": 1, "1k tokens": 1000 };

export function rowsFromAwsOffer(offer: AwsOfferFile, dateRead: string): { rows: PriceRow[]; unmapped: number } {
  const rows: PriceRow[] = [];
  let unmapped = 0;
  for (const product of Object.values(offer.products)) {
    const { model, inferenceType, usagetype, regionCode } = product.attributes;
    // Some products (xai.grok-4.3, xai.grok-4.6) leave inferenceType empty;
    // their usagetype still names the tokens.
    if (!model || !usagetype || !regionCode || !/token/i.test(`${inferenceType ?? ""} ${usagetype}`)) continue;
    if (NOT_BEDROCK_EDITION.test(product.attributes.servicename ?? "")) continue;
    if (NOT_CHAT_MODEL.test(model) || SKIP.test(usagetype) || SKIP.test(inferenceType ?? "")) continue;
    const parsed = parseAwsUsageType(usagetype);
    const dimensions = Object.values(offer.terms.OnDemand?.[product.sku] ?? {}).flatMap((t) => Object.values(t.priceDimensions));
    const prices = dimensions
      .map((d) => ({ factor: PER_UNIT[d.unit.toLowerCase()], usd: Number(d.pricePerUnit.USD) }))
      .filter((p) => p.factor !== undefined && Number.isFinite(p.usd));
    if (!parsed || prices.length === 0) {
      unmapped++;
      continue;
    }
    rows.push({
      provider: "bedrock",
      model: model.replace(/^OpenAI\s+/i, ""),
      ...parsed,
      region: regionCode,
      // Several dimensions on one product: never count less than the vendor can charge.
      usdPerMTok: round(Math.max(...prices.map((p) => p.usd * (p.factor as number)))),
      source: "aws-price-list",
      dateRead,
      stale: false,
      disagreement: false,
    });
  }
  return { rows, unmapped };
}

export async function readAws(fetcher: typeof fetch, dateRead: string): Promise<SourceRead> {
  try {
    const rows: PriceRow[] = [];
    let unmapped = 0;
    for (const offer of AWS_OFFERS) {
      const indexUrl = `${AWS_PRICING_BASE}/offers/v1.0/aws/${offer}/current/region_index.json`;
      const index = await getJson<{ regions: Record<string, { currentVersionUrl: string }> }>(fetcher, indexUrl);
      for (const region of Object.values(index.regions)) {
        const file = await getJson<AwsOfferFile>(fetcher, AWS_PRICING_BASE + region.currentVersionUrl);
        const read = rowsFromAwsOffer(file, dateRead);
        rows.push(...read.rows);
        unmapped += read.unmapped;
      }
    }
    if (rows.length === 0) throw new Error("AWS price-list files held no chat-model prices");
    return { source: "aws-price-list", ok: true, rows, unmapped };
  } catch (error) {
    return { source: "aws-price-list", ok: false, error: String(error instanceof Error ? error.message : error) };
  }
}

async function getJson<T>(fetcher: typeof fetch, url: string): Promise<T> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.json()) as T;
}
