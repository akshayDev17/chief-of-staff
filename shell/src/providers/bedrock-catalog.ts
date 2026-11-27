// Bedrock's own model list, and which priced model each Bedrock model ID is
// (T17: the model list on the Connect screen lists every chat model Bedrock sells at a listed price,
// of every model family).
//
//   readBedrockCatalog(fetcher, env, now) -> CatalogRead      the daily refresh
//   matchBedrockModels({ catalog, priced, reviewed }) -> BedrockOffer
//   readBedrockOffer(db, region) -> BedrockOffer | undefined  each request
//
// The catalog is read by the app's own role in the owner's AWS account (the
// issuer's ID token -> AssumeRoleWithWebIdentity, as for a model call) with
// ListFoundationModels and ListInferenceProfiles, for the region the app
// calls from, once a day beside the price table (src/prices/refresh.ts). The
// owner's catalog stands in for every user's: whether a model answers for a
// given user is proven by that user's test call. The users' own model-caller
// role (bedrock-template/) cannot list, and needs nothing new.
//   GET /foundation-models      "Lists Amazon Bedrock foundation models that you can use"
//   GET /inference-profiles     "Returns a list of inference profiles that you can use"
// https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html
// https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListInferenceProfiles.html
// (read 2026-11-26, no page dates; the field names below match the owner's
// live listing of that day, saved in test/fixtures/).
//
// Matching. The price table keys Bedrock's rows by the price list's own model
// names ("Gemma 3 4B", "GPT-6 Luna"), which follow no single pattern, and a
// wrong match would bill one model at another's price. So a price-list name
// is matched only by the rule (the same name or ID as Bedrock's list gives,
// ignoring case) or by a reviewed entry in bedrock-models.json; any other
// name is "not offered yet" with the reason. A model Bedrock marks LEGACY,
// or no longer lists as ACTIVE, is dropped from the list.
//
// Locations, per model: Global where ListInferenceProfiles names a `global.`
// profile for it; else, in the app's region, the model's own ID where it
// supports ON_DEMAND inference there, or the geography profile that profile
// list names for it from that region ("Specify a foundation model if the
// model supports on-demand inference in the Region" against "a cross-Region
// (system-defined) inference profile if the model is served only through an
// inference profile", and "Don't rely on the geographic prefix in an
// inference profile ID alone", Bedrock user guide, read 2026-11-26). Each is
// offered only where the price table has a row for it: Global at Global rows,
// the region at the region's own rows, which are also what a geography
// profile bills at (AWS's price list names no cross-Region rows; Claude 4.5
// and later have no in-Region ID, yet their non-Global rows are "standard").

import { mintIdToken, readIssuer } from "../issuer";
import { currentSnapshot, readStoredBedrockCatalog } from "../prices/store";
import { hasLongPromptRule } from "./anthropic";
import { assumeRoleWithWebIdentity, signV4, withoutHost, type AwsCredentials } from "./aws";
import { AWS_AUDIENCE, AWS_SUBJECT, type BedrockEnv } from "./bedrock";
import reviewedFile from "./bedrock-models.json";

export interface CatalogModel {
  modelId: string;
  modelName: string;
  providerName: string;
  inputModalities: string[];
  outputModalities: string[];
  inferenceTypesSupported: string[];
  // ACTIVE or LEGACY.
  lifecycle: string;
}

export interface CatalogProfile {
  id: string;
  // The foundation models it routes to: their IDs, and each one's region
  // (empty for a Global profile's own entry).
  models: Array<{ region: string; modelId: string }>;
}

export interface BedrockCatalog {
  region: string;
  readAt: string;
  models: CatalogModel[];
  profiles: CatalogProfile[];
}

export type CatalogRead = { ok: true; catalog: BedrockCatalog } | { ok: false; error: string };

// One price-table name at Bedrock: the deployment types it has an input
// price at (Global anywhere, or regional in the app's region), and whether it
// lists long-prompt rows.
export interface PricedName {
  name: string;
  deployments: string[];
  longPrompt: boolean;
}

export interface ReviewedModels {
  names: Record<string, string>;
  noToolUse: Array<{ prefix: string; tested: string; evidence: string }>;
  // Providers and model-ID prefixes Bedrock does not sell through AWS Marketplace.
  notMarketplace: { providers: string[]; models: string[] };
}

export const REVIEWED: ReviewedModels = reviewedFile;

// Where the app calls a model: the location the price table and the user's
// record name ("global", or the app's region), and the ID the call uses there.
export interface BedrockLocation {
  location: string;
  callId: string;
  // "global", "in-region" or the geography profile's prefix ("us", "eu").
  kind: string;
}

export type ModelOffer =
  // `noToolUse`: the live check that found the model makes no tool call.
  | { kind: "callable"; modelId: string; locations: BedrockLocation[]; noToolUse?: string }
  // `pricedAt`: where the price table prices it, so its row still shows
  // its list price (a dropped model's too, for a user who added it).
  | { kind: "not_offered"; reason: string; pricedAt: string[] }
  | { kind: "dropped"; pricedAt: string[] };

export interface BedrockOffer {
  region: string;
  readAt: string;
  byName: Record<string, ModelOffer>;
}

const modelIdOfArn = (arn: string): string => arn.slice(arn.indexOf("foundation-model/") + "foundation-model/".length);
const regionOfArn = (arn: string): string => arn.split(":")[3] ?? "";

// The parts of Bedrock's two List replies the app keeps.
export function catalogFromReplies(region: string, readAt: string, models: unknown, profiles: unknown[]): BedrockCatalog {
  const summaries = ((models as { modelSummaries?: unknown[] } | null)?.modelSummaries ?? []) as Array<Record<string, unknown>>;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
  return {
    region,
    readAt,
    models: summaries
      .filter((m) => typeof m.modelId === "string")
      .map((m) => ({
        modelId: m.modelId as string,
        modelName: typeof m.modelName === "string" ? m.modelName : "",
        providerName: typeof m.providerName === "string" ? m.providerName : "",
        inputModalities: strings(m.inputModalities),
        outputModalities: strings(m.outputModalities),
        inferenceTypesSupported: strings(m.inferenceTypesSupported),
        lifecycle: String((m.modelLifecycle as { status?: unknown } | undefined)?.status ?? ""),
      })),
    profiles: profiles
      .flatMap((page) => ((page as { inferenceProfileSummaries?: unknown[] } | null)?.inferenceProfileSummaries ?? []) as Array<Record<string, unknown>>)
      .filter((p) => typeof p.inferenceProfileId === "string" && p.status === "ACTIVE")
      .map((p) => ({
        id: p.inferenceProfileId as string,
        models: ((p.models ?? []) as Array<{ modelArn?: unknown }>)
          .filter((m) => typeof m.modelArn === "string")
          .map((m) => ({ region: regionOfArn(m.modelArn as string), modelId: modelIdOfArn(m.modelArn as string) })),
      })),
  };
}

async function listGet(fetcher: typeof fetch, url: string, region: string, credentials: AwsCredentials, now: Date): Promise<unknown> {
  const headers = await signV4({ method: "GET", url, region, service: "bedrock", credentials, now, headers: { accept: "application/json" } });
  const response = await fetcher(url, { method: "GET", headers: withoutHost(headers) });
  const text = await response.text();
  if (!response.ok) {
    let words = text;
    try {
      const body = JSON.parse(text) as { message?: unknown; Message?: unknown };
      words = String(body.message ?? body.Message ?? text);
    } catch {
      // Not JSON: AWS's own words as they came.
    }
    const name = response.headers.get("x-amzn-errortype")?.split(":")[0] ?? `HTTP ${response.status}`;
    throw new Error(`${new URL(url).pathname} answered ${response.status} ${name}${words ? `: ${words.slice(0, 300)}` : ""}`);
  }
  return JSON.parse(text) as unknown;
}

// What the owner adds to the app's own role (scripts/provider-setup-lib.mjs).
export const CATALOG_ACTIONS = ["bedrock:ListFoundationModels", "bedrock:ListInferenceProfiles"] as const;

export async function readBedrockCatalog(fetcher: typeof fetch, env: BedrockEnv, region: string, now: Date): Promise<CatalogRead> {
  try {
    if (!env.AWS_APP_ROLE_ARN) throw new Error("AWS_APP_ROLE_ARN is not set");
    const issuer = await readIssuer(env);
    const credentials = await assumeRoleWithWebIdentity(fetcher, {
      region,
      roleArn: env.AWS_APP_ROLE_ARN,
      sessionName: "chief-of-staff-catalog",
      webIdentityToken: await mintIdToken(issuer, { audience: AWS_AUDIENCE, subject: AWS_SUBJECT, now }),
    });
    const base = `https://bedrock.${region}.amazonaws.com`;
    const models = await listGet(fetcher, `${base}/foundation-models`, region, credentials, now);
    const pages: unknown[] = [];
    let next = "";
    for (let page = 0; page < 50; page++) {
      const url = new URL(`${base}/inference-profiles`);
      url.searchParams.set("maxResults", "1000");
      url.searchParams.set("typeEquals", "SYSTEM_DEFINED");
      if (next) url.searchParams.set("nextToken", next);
      const body = await listGet(fetcher, url.toString(), region, credentials, now);
      pages.push(body);
      next = String((body as { nextToken?: unknown } | null)?.nextToken ?? "");
      if (!next) break;
    }
    const catalog = catalogFromReplies(region, now.toISOString(), models, pages);
    if (catalog.models.length === 0) throw new Error("ListFoundationModels returned no models");
    return { ok: true, catalog };
  } catch (error) {
    const refusal = error as { refusal?: { step: string; errorName: string; message: string } };
    const words = refusal.refusal ? `${refusal.refusal.step} ${refusal.refusal.errorName}: ${refusal.refusal.message}` : error instanceof Error ? error.message : String(error);
    return { ok: false, error: words };
  }
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

// A chat model Bedrock serves on demand or through a profile: text out, not
// an embedding or a reranker, and not a provisioned-only variant ("…:24k").
const isChatModel = (m: CatalogModel): boolean =>
  m.outputModalities.includes("TEXT") &&
  !m.outputModalities.includes("EMBEDDING") &&
  !/rerank/i.test(m.modelId) &&
  m.inferenceTypesSupported.some((t) => t === "ON_DEMAND" || t === "INFERENCE_PROFILE");

// The Bedrock model a price-list name prices: the reviewed entry, else the one
// chat model of the same name or ID.
function modelFor(name: string, catalog: BedrockCatalog, reviewed: ReviewedModels): CatalogModel | "none" | "several" | "reviewed_missing" {
  const id = reviewed.names[name];
  if (id) return catalog.models.find((m) => m.modelId === id) ?? "reviewed_missing";
  const found = catalog.models.filter((m) => isChatModel(m) && (same(m.modelName, name) || same(m.modelId, name)));
  return found.length === 1 ? found[0]! : found.length ? "several" : "none";
}

export const noToolUseOf = (modelId: string, reviewed: ReviewedModels = REVIEWED): string | undefined => reviewed.noToolUse.find((r) => modelId.startsWith(r.prefix))?.tested;

// Every location Bedrock's lists offer the model at, from the app's region,
// Global first: Global is the app's default where it is offered (design-v3 1.5).
export function catalogLocations(m: CatalogModel, catalog: BedrockCatalog): BedrockLocation[] {
  const routes = catalog.profiles.filter((p) => p.models.some((r) => r.modelId === m.modelId));
  const out: BedrockLocation[] = [];
  const global = routes.find((p) => p.id.startsWith("global."));
  if (global) out.push({ location: "global", callId: global.id, kind: "global" });
  if (m.inferenceTypesSupported.includes("ON_DEMAND")) {
    out.push({ location: catalog.region, callId: m.modelId, kind: "in-region" });
  } else {
    const geo = routes.find((p) => !p.id.startsWith("global.") && p.models.some((r) => r.region === catalog.region && r.modelId === m.modelId));
    if (geo) out.push({ location: catalog.region, callId: geo.id, kind: geo.id.slice(0, geo.id.indexOf(".")) });
  }
  return out;
}

export function matchBedrockModels(input: { catalog: BedrockCatalog; priced: readonly PricedName[]; reviewed?: ReviewedModels }): BedrockOffer {
  const { catalog, priced } = input;
  const reviewed = input.reviewed ?? REVIEWED;
  const byName: Record<string, ModelOffer> = {};
  for (const p of priced) {
    const pricedAt = [...(p.deployments.includes("global") ? ["global"] : []), ...(p.deployments.includes("regional") ? [catalog.region] : [])];
    const notOffered = (reason: string): ModelOffer => ({ kind: "not_offered", reason, pricedAt });
    const m = modelFor(p.name, catalog, reviewed);
    if (m === "none") {
      byName[p.name] = notOffered(`Bedrock's own model list (${catalog.region}) has no model of this name`);
      continue;
    }
    if (m === "several") {
      byName[p.name] = notOffered("more than one model in Bedrock's own list has this name, so the app does not guess which");
      continue;
    }
    if (m === "reviewed_missing") {
      byName[p.name] = notOffered(`Bedrock's own model list (${catalog.region}) no longer has the model ID the app has for it`);
      continue;
    }
    if (m.lifecycle !== "ACTIVE" || !isChatModel(m)) {
      byName[p.name] = { kind: "dropped", pricedAt };
      continue;
    }
    const all = catalogLocations(m, catalog);
    if (!all.length) {
      byName[p.name] = notOffered(`Bedrock offers it in ${catalog.region} only with provisioned throughput`);
      continue;
    }
    // A model priced by prompt length whose rule the app does not know would
    // be costed at its standard rates on a long prompt: too low.
    if (p.longPrompt && !hasLongPromptRule(m.modelId)) {
      byName[p.name] = notOffered("the app does not know yet at what prompt length its long-prompt prices start, so it could count its cost too low");
      continue;
    }
    const offered = all.filter((l) => pricedAt.includes(l.location));
    byName[p.name] = { kind: "callable", modelId: m.modelId, locations: offered.length ? offered : all, noToolUse: noToolUseOf(m.modelId, reviewed) };
  }
  return { region: catalog.region, readAt: catalog.readAt, byName };
}

// The current snapshot's catalog and Bedrock price names, matched; undefined
// before the app has read Bedrock's list for the first time.
export async function readBedrockOffer(db: D1Database, region: string): Promise<BedrockOffer | undefined> {
  const snapshot = await currentSnapshot(db);
  if (!snapshot) return undefined;
  const catalog = await readStoredBedrockCatalog(db, snapshot.id);
  // A list read for another region names other models and profiles.
  if (!catalog || catalog.region !== region) return undefined;
  const { results } = await db
    .prepare(
      `SELECT model, deployment, max(long_prompt) AS long_prompt FROM price_rows
       WHERE snapshot_id = ?1 AND provider = 'bedrock' AND batch = 0 AND token_kind = 'input' AND (deployment = 'global' OR region = ?2)
       GROUP BY model, deployment`,
    )
    .bind(snapshot.id, region)
    .all<{ model: string; deployment: string; long_prompt: number }>();
  const byName = new Map<string, PricedName>();
  for (const r of results) {
    const p = byName.get(r.model) ?? { name: r.model, deployments: [], longPrompt: false };
    p.deployments.push(r.deployment === "global" ? "global" : "regional");
    p.longPrompt ||= r.long_prompt === 1;
    byName.set(r.model, p);
  }
  return matchBedrockModels({ catalog, priced: [...byName.values()] });
}
