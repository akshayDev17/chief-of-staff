// The Amazon Bedrock plug-in (design-v3 1.6, T16).
//
// Connect: the user types their 12-digit AWS account ID and taps Connect
// Amazon Bedrock; a CloudFormation quick-create link opens the stack
// `bedrock-template/template.json` makes: one role,
// `chief-of-staff-model-caller`, that can call models and, from template
// 1.1.0, accept Bedrock models' Marketplace terms on first use, and trusts the app's own role in the
// owner's account only with the user's external ID. The record holds that
// role's ARN and the external ID, neither secret ("AWS does not treat the
// external ID as a secret", data/cos-provider-connect/report.md).
//
// Credential: the issuer's ID token -> AssumeRoleWithWebIdentity into the
// app's own role (no AWS key held) -> AssumeRole into the user's role with
// the external ID: one hour at most, since role chaining caps it there.
//
// Caller: Converse, `POST /model/{modelId}/converse` on
// bedrock-runtime.<region>.amazonaws.com, signed with those credentials.
// Its `usage` gives `inputTokens` ("represents only the non-cached input
// tokens" with caching on), `cacheReadInputTokens`, `cacheWriteInputTokens`
// and `cacheDetails`, the writes "by TTL" (`5m` or `1h`). Pages read
// 2026-11-25, no page dates:
// https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
// https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_TokenUsage.html
// https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
//
// Price source: AWS's price-list files (src/prices/aws.ts).

import { AppNotConfigured, mintIdToken, readIssuer } from "../issuer";
import type { ConnectionFields, ConnectMethod, Failure, Link, ProviderPlugin, Usage } from "../proxy/plugin";
import { isLongPrompt, readBody, splitCacheWrites, TEST_MAX_TOKENS, TEST_PROMPT } from "./anthropic";
import { assumeRole, assumeRoleWithWebIdentity, signV4, withoutHost, xmlText, type AwsCredentials } from "./aws";
import { readAccountStates } from "./bedrock-account";
import type { BedrockLocation, BedrockOffer, ModelOffer } from "./bedrock-catalog";

export interface BedrockEnv {
  APP_ORIGIN?: string;
  ISSUER_KEYS?: string;
  // The app's own role in the owner's AWS account (T10; not secret).
  AWS_APP_ROLE_ARN?: string;
  // Where the app calls STS and Bedrock from, and opens the stack. Default us-east-1.
  AWS_REGION?: string;
  // The published template the quick-create link opens (release workflow, T10).
  BEDROCK_TEMPLATE_URL?: string;
}

export const ROLE_NAME = "chief-of-staff-model-caller";
export const STACK_NAME = "chief-of-staff";
// What the app's own role trusts in the issuer's token
// (scripts/provider-setup.mjs prints the matching trust policy).
export const AWS_AUDIENCE = "sts.amazonaws.com";
export const AWS_SUBJECT = "chief-of-staff:bedrock";
const SESSION_NAME = "chief-of-staff";

// Which models the model list offers, and at which IDs and locations, comes
// from Bedrock's own model list, read daily by the app's own role and
// matched to the price table's names (src/providers/bedrock-catalog.ts, T17):
// every chat model Bedrock sells at a listed price, of every model family.
//
// The app's built-in IDs, from each model card's "Programmatic Access" table
// (read 2026-11-25 and 2026-11-27; launch dates on the cards): the four
// Claude models T16 added and Amazon Nova 2 Lite, the Connect test call's
// model (below), at Global or the geography profile of the app's region.
// Once the list names a model, its verdict wins, for these models too; a
// built-in ID serves only a name the list has no entry for (before the list
// has been read once, the owner's AWS step adding the two List actions to
// the app's role, or a name not priced at this region). The Connect test call
// alone always uses the test model's built-in profile IDs (`testModelIds`).
export const BEDROCK_MODEL_IDS: Readonly<Record<string, string>> = {
  "Claude Haiku 5.5": "anthropic.claude-haiku-5-5",
  "Claude Sonnet 5.5": "anthropic.claude-sonnet-5-5",
  "Claude Opus 5.5": "anthropic.claude-opus-5-5",
  "Claude Haiku 4.5": "anthropic.claude-haiku-4-5-20251001-v1:0",
  // Named as AWS's price list names it, so its price rows match. Card read
  // 2026-11-27: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-lite.html
  "Nova 2.0 Lite": "amazon.nova-2-lite-v1:0",
};

// The Connect test call's model: one AWS sells itself, not through AWS
// Marketplace, so it answers with no Marketplace agreement and through a
// 1.0.0 role that cannot accept one (Bedrock's model-access page lists Amazon
// among the providers whose models "aren't sold through AWS Marketplace";
// read 2026-11-27). Nova 2 Lite over Nova Micro: it has a Global profile, as
// the app's locations expect, and US, EU and JP profiles; Nova Micro has no
// Global profile, only US and EU, and its card says "EOL no sooner than: Dec
// 05, 2025" (Nova 2 Lite's: Dec 02, 2026).
export const TEST_MODEL = "Nova 2.0 Lite";

// The first template whose role can accept a Bedrock model's AWS Marketplace
// terms on its first call (bedrock-template/README.md).
export const MARKETPLACE_TERMS_SINCE = "1.1.0";

// Whether a stack's template version is older than `than`; a version never
// read counts as older.
export function olderTemplate(version: string | undefined, than: string): boolean {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return true;
  const [a, b] = [version, than].map((v) => v.split(".").map(Number));
  const i = a!.findIndex((n, k) => n !== b![k]);
  return i !== -1 && a![i]! < b![i]!;
}

// The geography prefix of a cross-Region inference profile, from the region
// the app calls from.
export function geography(region: string): string {
  if (region === "ap-southeast-2" || region === "ap-southeast-4") return "au";
  if (region === "ap-northeast-1" || region === "ap-northeast-3") return "jp";
  const prefix = region.split("-")[0]!;
  return ["us", "eu", "ca"].includes(prefix) ? prefix : "us";
}

export const regionOf = (env: BedrockEnv): string => env.AWS_REGION?.trim() || "us-east-1";

// A built-in model's locations: each has a Global profile and a geography
// profile, and no in-Region ID.
function builtInOffer(model: string, region: string): ModelOffer | undefined {
  const id = BEDROCK_MODEL_IDS[model];
  if (!id) return undefined;
  const geo = geography(region);
  return {
    kind: "callable",
    modelId: id,
    locations: [
      { location: "global", callId: `global.${id}`, kind: "global" },
      { location: region, callId: `${geo}.${id}`, kind: geo },
    ],
  };
}

// Bedrock's 30-minute cache: the models whose price list sells their cache
// writes as "cache_write_tokens_30m" (the price parser files those rows as
// the model's cache_write rows, its only kind of cache write), from the
// us-east-1 price-list files of 2026-11-23; test/bedrock-catalog.test.ts
// checks the list against them. A write Converse reports with the "30m" TTL
// is costed at that row for these models only; for any other model it is
// counted as a 1-hour write, the dearer kind, as any write of unknown TTL is.
const THIRTY_MINUTE_CACHE: ReadonlySet<string> = new Set([
  "openai.gpt-5.6-luna", "openai.gpt-5.6-sol", "openai.gpt-5.6-terra",
  "openai.gpt-6-astra", "openai.gpt-6-luna", "openai.gpt-6-sol",
  "openai.gpt-6.1-sol", "openai.gpt-6.1-terra", "openai.gpt-6.2-astra", "openai.gpt-6.2-sol",
  "moonshotai.kimi-k3",
]);

// A model ID without its inference profile's prefix ("global.", "us.").
export const baseModelId = (callId: string): string => callId.replace(/^(?:global|us-gov|us|eu|apac|au|jp|ca)\./, "");

export const hasThirtyMinuteCache = (callId: string): boolean => THIRTY_MINUTE_CACHE.has(baseModelId(callId));

export function quickCreateLink(input: { region: string; templateUrl: string; appRoleArn: string; externalId: string }): string {
  // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-create-stacks-quick-create-links.html
  // (read 2026-11-25): .../#/stacks/create/review?templateURL=...&stackName=...&param_<name>=<value>
  const q = new URLSearchParams({
    templateURL: input.templateUrl,
    stackName: STACK_NAME,
    param_ExternalId: input.externalId,
    param_AppRoleArn: input.appRoleArn,
  });
  return `https://${input.region}.console.aws.amazon.com/cloudformation/home?region=${input.region}#/stacks/create/review?${q}`;
}

const randomHex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

// Usage from a Converse reply. Reasoning models (gpt-oss, DeepSeek R1,
// MiniMax, Nemotron) count their reasoning in `outputTokens`: on every call
// of the owner's family check, input + output = total (us-east-1,
// 2026-11-26 and 2026-11-27). Should a reply's `totalTokens` ever exceed the
// counts it gives, the rest is counted as output, so a family that counts
// otherwise is never costed below what AWS bills.
export function usageFromConverse(body: unknown, modelId: string): Usage | undefined {
  const u = (body as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u !== "object") return undefined;
  const details = Array.isArray(u.cacheDetails) ? (u.cacheDetails as Array<{ ttl?: string; inputTokens?: unknown }>) : [];
  const byTtl = (ttl: string) => details.filter((d) => d?.ttl === ttl).reduce((sum, d) => sum + count(d.inputTokens), 0);
  const input = count(u.inputTokens);
  const cachedInput = count(u.cacheReadInputTokens);
  const shortWrites = byTtl("5m") + (hasThirtyMinuteCache(modelId) ? byTtl("30m") : 0);
  const writes = splitCacheWrites(count(u.cacheWriteInputTokens), shortWrites, byTtl("1h"));
  const counted = input + cachedInput + writes.cacheWrite + writes.cacheWrite1h + count(u.outputTokens);
  return {
    input,
    cachedInput,
    ...writes,
    output: count(u.outputTokens) + Math.max(0, count(u.totalTokens) - counted),
    longPrompt: isLongPrompt(modelId, input + cachedInput + writes.cacheWrite + writes.cacheWrite1h),
  };
}

// The error name Bedrock gives a refusal: its `x-amzn-ErrorType` header
// ("AccessDeniedException:http://..."), else `__type` in the body.
function bedrockError(response: Response, body: unknown): { name: string; message: string } {
  const header = response.headers.get("x-amzn-errortype")?.split(":")[0]?.trim();
  const b = (body ?? {}) as { __type?: unknown; message?: unknown; Message?: unknown };
  const typed = typeof b.__type === "string" ? b.__type.split("#").pop() : undefined;
  const message = typeof b.message === "string" ? b.message : typeof b.Message === "string" ? b.Message : typeof body === "string" ? body : "";
  return { name: header || typed || `HTTP ${response.status}`, message };
}

const CONSOLE_MODEL_ACCESS: Link = { label: "Open Bedrock's model access", href: "https://console.aws.amazon.com/bedrock/home#/modelaccess" };

// `offer` is Bedrock's own model list matched to the price table
// (readBedrockOffer), absent until the app has read that list once.
export function bedrockPlugin(env: BedrockEnv, fetcher: typeof fetch = fetch, now: () => Date = () => new Date(), offer?: BedrockOffer): ProviderPlugin {
  const region = regionOf(env);
  const offerFor = (model: string): ModelOffer | undefined => offer?.byName[model] ?? builtInOffer(model, region);
  const locationOf = (model: string, location: string): BedrockLocation | undefined => {
    const o = offerFor(model);
    return o?.kind === "callable" ? o.locations.find((l) => l.location === location) : undefined;
  };

  const setupLink = (externalId: string): string | undefined =>
    env.BEDROCK_TEMPLATE_URL && env.AWS_APP_ROLE_ARN
      ? quickCreateLink({ region, templateUrl: env.BEDROCK_TEMPLATE_URL, appRoleArn: env.AWS_APP_ROLE_ARN, externalId })
      : undefined;

  const modelId = (model: string, location: string): string | undefined => locationOf(model, location)?.callId;
  const testOffer = builtInOffer(TEST_MODEL, region);
  const testLocations = testOffer?.kind === "callable" ? testOffer.locations : [];

  const connect: ConnectMethod = {
    guide: {
      name: "Amazon Bedrock",
      short: "Bedrock",
      vendor: "AWS",
      recommendedForFriends: true,
      steps: [
        "An AWS account with a payment method for Marketplace purchases.",
        "Type your 12-digit AWS account ID (not secret) and tap <strong>Connect Amazon Bedrock</strong>: AWS opens a ready-filled stack.",
        'Scroll to the bottom and tick <strong>"I acknowledge that AWS CloudFormation might create IAM resources with custom names."</strong> This is for the one role, chief-of-staff-model-caller, which can call models and accept Bedrock models\' Marketplace terms on first use.',
        "Press <strong>Create stack</strong>.",
        "Wait until the stack's status reads CREATE_COMPLETE, which takes about a minute.",
        "The Connect test call always runs on Amazon Nova 2 Lite, which AWS sells itself, whatever models you choose. Claude and OpenAI GPT (not gpt-oss) models are sold through AWS Marketplace: the role accepts each one's terms by itself on the first call to it, when you choose it, which can take up to 15 minutes. Every other model family needs nothing. For Claude models older than Claude Opus 4.7, AWS also asks its one-time use-case form.",
        "The form is expected and is filled once per AWS account (or once in an AWS Organization's management account). An individual may enter their own name, a personal site or GitHub profile as the website, and a plain personal use case.",
        "Go back to the Chief of staff tab and finish the Connect step so the test call runs.",
        "Once it passes, choose your models in the list below it: each runs its own test call once. <strong>Refresh model list</strong> reads Bedrock's list again now and checks, in your own account, which models still need their terms accepted or Anthropic's form.",
        `Connected before, and Providers shows “Stack template version 1.0.0” or “1.1.0”? Update the stack once so its role can accept those terms and read each model's state for Refresh model list: in AWS CloudFormation, select the “${STACK_NAME}” stack, choose <strong>Update</strong>, then <strong>Replace existing template</strong>${env.BEDROCK_TEMPLATE_URL ? ` with this Amazon S3 URL: ${env.BEDROCK_TEMPLATE_URL}` : ""}. Keep the parameters, tick the same acknowledgement and submit.`,
      ],
      checkedOn: "2026-11-27",
      pages: [
        { label: "Quick-create links", href: "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-create-stacks-quick-create-links.html" },
        { label: "Access Amazon Bedrock foundation models", href: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html" },
        { label: "Third-party access with an external ID", href: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_common-scenarios_third-party.html" },
      ],
      revoke: "delete the “chief-of-staff” stack in AWS CloudFormation.",
      regionChoice: true,
    },
    fields: [
      { name: "accountId", label: "AWS account ID", placeholder: "123456789012", pattern: "\\d{12}", problem: "An AWS account ID is 12 digits." },
    ],
    start(typed, { existing }) {
      const accountId = typed.accountId!;
      const roleArn = `arn:aws:iam::${accountId}:role/${ROLE_NAME}`;
      // One external ID per user, generated by the app ("a random string
      // generated by the third party"), kept when the same role is connected again.
      const externalId = existing?.roleArn === roleArn && existing.externalId ? existing.externalId : randomHex(16);
      return { kind: "connection", fields: { roleArn, externalId }, open: setupLink(externalId) };
    },
    setupLink: (connection) => setupLink(connection.externalId!),
    testModel: TEST_MODEL,
    testModelIds: Object.fromEntries(testLocations.map((l) => [l.location, l.callId])),
    knownModels: Object.keys(BEDROCK_MODEL_IDS),
    // Converse speaks every model family, but the call needs Bedrock's own ID
    // for the model: one Bedrock's list gives for its price-list name.
    canCall: (model) => offerFor(model)?.kind === "callable",
    notCallableReason(model) {
      const o = offerFor(model);
      if (o?.kind === "not_offered") return o.reason;
      if (o?.kind === "dropped") return "Bedrock's own model list marks it legacy, or no longer as a chat model";
      return offer ? "the app has no Bedrock ID for it" : "the app has not read Bedrock's own model list yet (Admin's one-time AWS step)";
    },
    listed: (model) => offerFor(model)?.kind !== "dropped",
    noToolUse(model) {
      const o = offerFor(model);
      return o?.kind === "callable" ? o.noToolUse : undefined;
    },
    // Converse's reply does not name the model.
    replyModel: () => undefined,
    // Global first where Bedrock offers it, then the app's region: in-Region
    // or through the geography profile Bedrock names (bedrock-catalog.ts).
    locations(model) {
      const o = offerFor(model);
      if (o?.kind === "callable") return o.locations.map((l) => l.location);
      return o?.pricedAt.length ? o.pricedAt : ["global"];
    },
    locationLabel(location, model) {
      if (location === "global") return "Global";
      const l = model ? (locationOf(model, location) ?? (model === TEST_MODEL ? testLocations.find((t) => t.location === location) : undefined)) : undefined;
      if (l?.kind === "in-region") return `${location} in-Region`;
      if (l) return `${l.kind.toUpperCase()} cross-Region from ${location}`;
      return location;
    },
    modelId,
    // At 5 tokens a reasoning model (gpt-oss, MiniMax, DeepSeek R1) can spend
    // them all on reasoning and answer 200 with no text: the test call passes
    // on that 200, and the reply shows no words (owner's family check,
    // us-east-1, 2026-11-26: "max_tokens, reasoning only").
    testRequest: () => ({ messages: [{ role: "user", content: [{ text: TEST_PROMPT }] }], inferenceConfig: { maxTokens: TEST_MAX_TOKENS } }),
    // The text blocks only; a `reasoningContent` block has no `text`.
    replyText(body) {
      const content = (body as { output?: { message?: { content?: Array<{ text?: string }> } } } | null)?.output?.message?.content;
      const text = Array.isArray(content) ? content.map((c) => c?.text ?? "").join("").trim() : "";
      return text || undefined;
    },
    classify(f: Failure, connection: ConnectionFields | undefined, setupVersion?: string) {
      const said = `${f.errorName} ${f.message}`;
      const stack: Link[] = connection?.externalId && setupLink(connection.externalId) ? [{ label: "Connect Amazon Bedrock", href: setupLink(connection.externalId)! }] : [];
      if (f.step === "credential") {
        if (f.exchange === "AssumeRole" && /AccessDenied/i.test(f.errorName)) {
          return { reason: "not_set_up", fix: "Create the stack again with Connect Amazon Bedrock, then try again.", links: stack };
        }
        if (f.exchange === "AssumeRoleWithWebIdentity") {
          return { reason: "app_not_configured", fix: "The app's own AWS role did not accept the app's token: Admin's one-time AWS step needs checking.", links: [] };
        }
        return { reason: "refused", fix: "Try again; if it keeps failing, create the stack again with Connect Amazon Bedrock.", links: stack };
      }
      // "Marketplace Agreement Pending" and MPAgreementBeingCreated: the first
      // call to a model starts its subscription, "up to 15 minutes" (Bedrock
      // troubleshooting and model-access pages, read 2026-11-25).
      if (/MPAgreementBeingCreated|Marketplace Agreement Pending|agreement (is )?being created/i.test(said)) {
        return { reason: "switching_on", fix: "", links: [] };
      }
      if (/FTUFormNotFilled|use case|use-case/i.test(said)) {
        return { reason: "not_allowed_yet", fix: "Fill in Anthropic's one-time use-case form in the Bedrock console, then try again.", links: [CONSOLE_MODEL_ACCESS] };
      }
      if (f.status === 404 || /ResourceNotFound/i.test(f.errorName)) {
        return { reason: "no_such_model", fix: "Change the region, or pick a model this account offers.", links: [] };
      }
      // No Marketplace agreement (live, 2026-11-27: "anthropic.claude-haiku-5-5
      // is not available for this account. You can explore other available
      // models on Amazon Bedrock. For additional access options, contact AWS
      // Sales"). A stack older than 1.1.0 has a role that cannot make one: it
      // is updated to the new template, never created again. A newer role
      // can, for the products its template lists, so the terms are accepted
      // once in the Bedrock console instead.
      if (/is not available for this account/i.test(f.message)) {
        if (olderTemplate(setupVersion, MARKETPLACE_TERMS_SINCE)) {
          return {
            reason: "no_permission",
            fix: `Update the “${STACK_NAME}” stack to the new template, so its role can accept this model's AWS Marketplace terms on its first call: in AWS CloudFormation, select the stack, choose Update, then Replace existing template${env.BEDROCK_TEMPLATE_URL ? ` with this Amazon S3 URL: ${env.BEDROCK_TEMPLATE_URL}` : ""}. Keep the parameters, tick the same acknowledgement and submit, then try again.`,
            links: [{ label: "Open AWS CloudFormation", href: `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks` }],
          };
        }
        return { reason: "not_allowed_yet", fix: "This model is sold through AWS Marketplace: the AWS account's owner accepts its terms once in the Bedrock console, then try again.", links: [CONSOLE_MODEL_ACCESS] };
      }
      if (/AccessDenied/i.test(f.errorName) && /access to the model|model access|not authorized to access|subscri/i.test(f.message)) {
        return { reason: "not_allowed_yet", fix: "Enable the model once in the Bedrock console (Model access), then try again.", links: [CONSOLE_MODEL_ACCESS] };
      }
      if (f.status === 403 || /AccessDenied/i.test(f.errorName)) {
        return { reason: "no_permission", fix: "The stack's role may have been changed: create the stack again with Connect Amazon Bedrock.", links: stack };
      }
      if (f.status === 429 || f.status === 503 || /Throttling|ModelNotReady|ServiceUnavailable/i.test(f.errorName)) {
        return { reason: "busy", fix: "Nothing to set up: try again in a minute.", links: [] };
      }
      return { reason: "refused", fix: "Bedrock's own words above say why.", links: [] };
    },
    async readSetupVersion(credential, connection) {
      // The template's version is an output of the user's own stack; the role
      // may read only its own stack (bedrock-template/template.json).
      const account = connection.roleArn?.split(":")[4];
      if (!account) return undefined;
      const url = `https://cloudformation.${region}.amazonaws.com/`;
      const body = new URLSearchParams({ Action: "DescribeStacks", Version: "2010-05-15", StackName: STACK_NAME }).toString();
      const headers = await signV4({
        method: "POST", url, body, region, service: "cloudformation", credentials: credential as AwsCredentials, now: now(),
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      });
      const response = await fetcher(url, { method: "POST", headers: withoutHost(headers), body });
      if (!response.ok) return undefined;
      const xml = await response.text();
      const output = /<member>\s*<OutputKey>TemplateVersion<\/OutputKey>\s*<OutputValue>([^<]*)<\/OutputValue>/.exec(xml)?.[1]
        ?? /<OutputValue>([^<]*)<\/OutputValue>\s*<OutputKey>TemplateVersion<\/OutputKey>/.exec(xml)?.[1];
      return output?.trim() || xmlText(xml, "TemplateVersion");
    },
    readAccountStates: (credential, modelIds) => readAccountStates(fetcher, credential as AwsCredentials, region, now(), modelIds),
  };

  return {
    provider: "bedrock",
    version: "bedrock-1.0.0",
    connectionFields: ["roleArn", "externalId"],
    priceSource: ["aws-price-list"],
    connect,
    async mintCredential(connection) {
      if (!env.AWS_APP_ROLE_ARN) throw new AppNotConfigured(["AWS_APP_ROLE_ARN"]);
      const issuer = await readIssuer(env);
      const at = now();
      const appCredentials = await assumeRoleWithWebIdentity(fetcher, {
        region,
        roleArn: env.AWS_APP_ROLE_ARN,
        sessionName: SESSION_NAME,
        webIdentityToken: await mintIdToken(issuer, { audience: AWS_AUDIENCE, subject: AWS_SUBJECT, now: at }),
      });
      return assumeRole(fetcher, {
        region,
        roleArn: connection.roleArn!,
        externalId: connection.externalId!,
        sessionName: SESSION_NAME,
        credentials: appCredentials,
        now: at,
      });
    },
    async call({ credential, model, location, modelId: pinned, request }) {
      const id = pinned ?? modelId(model, location);
      if (!id) throw new Error(`no Bedrock ID for ${model} at ${location}`);
      const callRegion = location === "global" ? region : location;
      const url = `https://bedrock-runtime.${callRegion}.amazonaws.com/model/${encodeURIComponent(id)}/converse`;
      const body = JSON.stringify(request);
      const headers = await signV4({
        method: "POST", url, body, region: callRegion, service: "bedrock", credentials: credential as AwsCredentials, now: now(),
        headers: { "content-type": "application/json", accept: "application/json" },
      });
      const response = await fetcher(url, { method: "POST", headers: withoutHost(headers), body });
      const reply = await readBody(response);
      if (!response.ok) return { status: response.status, body: reply, error: bedrockError(response, reply) };
      return { status: response.status, body: reply, usage: usageFromConverse(reply, id) };
    },
  };
}
