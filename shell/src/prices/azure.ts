// Reads Foundry's chat-model prices from the Azure Retail Prices API
// (service "Foundry Models", no credentials).
//
// Each Retail item is one meter. Its meterName packs the model, the kind of
// token, the deployment type and modifiers into abbreviations, for example
// "6-astra ShortCo Cd Inp Std Gl 1M Tokens" or "4.3 Cached Inp DZ L Tokens".
// A meter this reader cannot place in full (model, token kind and deployment
// type) is counted as unmapped and left out; nothing is guessed.

import { AZURE_RETAIL_URL } from "./sources";
import type { Deployment, PriceRow, SourceRead, TokenKind } from "./types";

export interface AzureRetailItem {
  retailPrice: number;
  armRegionName: string;
  meterName: string;
  productName: string;
  unitOfMeasure: string;
  type: string;
}

// Product (family) to the name prefix its meters leave out. Products not
// listed here sell no chat model at a per-token price (media, embeddings,
// fine-tuning, provisioned throughput, hosting) and are skipped.
const CHAT_PRODUCTS: Record<string, { prefix: string; suffix?: string }> = {
  "Azure OpenAI GPT6": { prefix: "GPT-" },
  "Azure OpenAI GPT5": { prefix: "GPT-" },
  "Azure OpenAI": { prefix: "" },
  "Azure OpenAI Reasoning": { prefix: "" },
  "Azure OpenAI OSS Models": { prefix: "" },
  "Azure Grok Models": { prefix: "Grok " },
  "Azure Deepseek Models": { prefix: "DeepSeek " },
  "Azure Kimi": { prefix: "Kimi " },
  "Azure Mistral Models": { prefix: "Mistral " },
  "Azure Llama Models": { prefix: "Llama " },
  "Cohere Models": { prefix: "Cohere " },
  "Azure Phi Models": { prefix: "" },
  "MAI Models": { prefix: "" },
  "Azure Fireworks Models": { prefix: "", suffix: " (Fireworks)" },
  "Azure Baseten Models": { prefix: "", suffix: " (Baseten)" },
};

// Meters that are not chat inference at a list price on demand.
const SKIP =
  /\b(ft|finetuned?|fine-?tun\w*|train\w*|hosting|dev|sample|rft|provisioned|flex|fl|pp|priority|image|img|audio|aud|video|pages|embed\w*|rerank|transcribe|parser|ocr|realtime\w*|rt|rtime|tts|whisper|sora|grader|search|assistants|session|computer-use|cyber)\b|12h|aud\d|realtime/i;

// "Model 6" / "Model 7" in Azure Kimi cannot be tied to a named model.
const UNNAMED_MODEL = /^model \d+$/i;

const KIND_PATTERNS: Array<[RegExp, TokenKind]> = [
  [/\b(cd|cache|cached)\s+(wr|write)\b/i, "cache_write"],
  [/\b(cached?|cd|cchd|ccchd)\s+(inp|input|in|inpt)\b|\b(inp|input|in|inpt)\s+(cached?|cd|cchd|ccchd)\b/i, "cached_input"],
  [/\b(cached?|ccchd)\b/i, "cached_input"],
  [/\b(inp|input|in|inpt)\b/i, "input"],
  [/\b(outp|outpt|output|opt|out|op)\b/i, "output"],
];

const DEPLOYMENT_PATTERNS: Array<[RegExp, Deployment]> = [
  [/\b(gl|glbl|global)\b/i, "global"],
  [/\b(us\s+)?(dz|dzone|data\s*zone|datazone)\b/i, "data-zone"],
  [/\b(regnl|regional|rgnl|regn)\b/i, "regional"],
];

const LONG = /\b(longco|loco|long|l)\b/i;
const MARKERS =
  /\b(longco|shortco|loco|shco|long|l|batch|std|tokens|1m|cd|cchd|ccchd|cache|cached|wr|write|inp|input|in|inpt|outp|outpt|output|opt|out|op|gl|glbl|global|us|dz|dzone|data\s*zone|datazone|regnl|regional|rgnl|regn)\b/gi;

export interface ParsedMeter {
  model: string;
  tokenKind: TokenKind;
  deployment: Deployment;
  longPrompt: boolean;
  batch: boolean;
}

export function parseAzureMeter(meterName: string, productName: string): ParsedMeter | undefined {
  const product = CHAT_PRODUCTS[productName];
  if (!product) return undefined;
  // Split hyphens off the abbreviations ("Phi-4-Input", "codex-out-glbl")
  // while keeping them inside model names ("Grok-3", "6-astra").
  const name = meterName
    .replace(/batch(?=(inp|outp|input|output))/gi, "batch ")
    .replace(/-(?=(input|output|inp|outp|out|inpt|cached|glbl|regnl|regional|datazone|dzone|gl|dz)\b)/gi, " ")
    .replace(/\b(input|output|inp|outp|out|inpt|cached|glbl|regnl)-/gi, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/\btokens$/i.test(name) || SKIP.test(name)) return undefined;
  const tokenKind = KIND_PATTERNS.find(([re]) => re.test(name))?.[1];
  const deployment = DEPLOYMENT_PATTERNS.find(([re]) => re.test(name))?.[1];
  if (!tokenKind || !deployment) return undefined;
  const rest = name.replace(MARKERS, " ").replace(/[\s-]+$/g, "").replace(/^[\s-]+/g, "").replace(/\s+/g, " ").trim();
  if (!rest || rest === "-" || UNNAMED_MODEL.test(rest)) return undefined;
  const bare = normaliseModel(rest.replace(/^fw\s+/i, "").replace(/^ds\b/i, "DeepSeek"));
  const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const prefix = product.prefix && !alnum(bare).startsWith(alnum(product.prefix)) ? product.prefix : "";
  const model = (prefix + bare + (product.suffix ?? "")).trim();
  return {
    model,
    tokenKind,
    deployment,
    longPrompt: LONG.test(name) && !/\b(shortco|shco)\b/i.test(name),
    batch: /\bbatch\b/i.test(name),
  };
}

// Azure spells one model several ways ("6.1-sol", "61sol", "6.1 sol";
// "V4.1Flash 1017", "V4.1 Flash1017"); bring each to one spelling.
export function normaliseModel(name: string): string {
  return name
    .replace(/^(\d)(\d)\s*-?\s*(astra|sol|terra|luna)\b/i, "$1.$2-$3")
    .replace(/^(\d(?:\.\d)?)\s*-?\s*(astra|sol|terra|luna)\b/i, "$1-$2")
    .replace(/([a-z])(\d{4})\b/gi, "$1 $2")
    .replace(/(\d)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

const PER_UNIT: Record<string, number> = { "1M": 1, "1K": 1000 };

export function rowsFromAzureItems(items: AzureRetailItem[], dateRead: string): { rows: PriceRow[]; unmapped: number } {
  const rows: PriceRow[] = [];
  let unmapped = 0;
  for (const item of items) {
    if (item.type !== "Consumption" || !CHAT_PRODUCTS[item.productName]) continue;
    const factor = PER_UNIT[item.unitOfMeasure];
    const parsed = factor ? parseAzureMeter(item.meterName, item.productName) : undefined;
    if (!parsed) {
      if (/tokens$/i.test(item.meterName) && !SKIP.test(item.meterName)) unmapped++;
      continue;
    }
    rows.push({
      provider: "foundry",
      ...parsed,
      region: item.armRegionName,
      usdPerMTok: round(item.retailPrice * factor),
      source: "azure-retail",
      dateRead,
      stale: false,
      disagreement: false,
    });
  }
  return { rows, unmapped };
}

export async function readAzure(fetcher: typeof fetch, dateRead: string): Promise<SourceRead> {
  try {
    const items: AzureRetailItem[] = [];
    let url: string | null = AZURE_RETAIL_URL;
    for (let page = 0; url && page < 500; page++) {
      const response = await fetcher(url);
      if (!response.ok) throw new Error(`Azure Retail Prices API answered ${response.status}`);
      const body = (await response.json()) as { Items: AzureRetailItem[]; NextPageLink: string | null };
      items.push(...body.Items);
      url = body.NextPageLink;
    }
    const { rows, unmapped } = rowsFromAzureItems(items, dateRead);
    if (rows.length === 0) throw new Error("Azure Retail Prices API returned no chat-model prices");
    return { source: "azure-retail", ok: true, rows, unmapped };
  } catch (error) {
    return { source: "azure-retail", ok: false, error: String(error instanceof Error ? error.message : error) };
  }
}

// Prices are decimal amounts; keep them free of float noise from the
// per-1K conversion.
export const round = (n: number): number => Math.round(n * 1e9) / 1e9;
