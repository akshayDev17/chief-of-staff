// The Amazon Bedrock plug-in (design-v3 1.6, T16).
//
// Connect: the user types their 12-digit AWS account ID and taps Connect
// Amazon Bedrock; a CloudFormation quick-create link opens the stack
// `bedrock-template/template.json` makes: one invoke-only role,
// `chief-of-staff-model-caller`, that trusts the app's own role in the
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

// Bedrock's own IDs for the models the app knows, from each model card's
// "Programmatic Access" table (read 2026-11-25; launch dates on the cards).
// Global and cross-Region calls prefix the ID with `global.` or the geography.
// The map holds only the four Claude models T16 added for the Connect test
// call. That is a known shortfall, not a rule: Add a model is meant to offer
// every chat model Bedrock sells at a listed price, of every model family
// (T17, design-v3 1.5), and every other model shows "not offered yet" until
// the T17 fix adds its ID here.
export const BEDROCK_MODEL_IDS: Readonly<Record<string, string>> = {
  "Claude Haiku 5.5": "anthropic.claude-haiku-5-5",
  "Claude Sonnet 5.5": "anthropic.claude-sonnet-5-5",
  "Claude Opus 5.5": "anthropic.claude-opus-5-5",
  "Claude Haiku 4.5": "anthropic.claude-haiku-4-5-20251001-v1:0",
};

// The geography prefix of a cross-Region inference profile, from the region
// the app calls from.
export function geography(region: string): string {
  if (region === "ap-southeast-2" || region === "ap-southeast-4") return "au";
  if (region === "ap-northeast-1" || region === "ap-northeast-3") return "jp";
  const prefix = region.split("-")[0]!;
  return ["us", "eu", "ca"].includes(prefix) ? prefix : "us";
}

export const regionOf = (env: BedrockEnv): string => env.AWS_REGION?.trim() || "us-east-1";

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

export function usageFromConverse(body: unknown, modelId: string): Usage | undefined {
  const u = (body as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u !== "object") return undefined;
  const details = Array.isArray(u.cacheDetails) ? (u.cacheDetails as Array<{ ttl?: string; inputTokens?: unknown }>) : [];
  const byTtl = (ttl: string) => details.filter((d) => d?.ttl === ttl).reduce((sum, d) => sum + count(d.inputTokens), 0);
  const input = count(u.inputTokens);
  const cachedInput = count(u.cacheReadInputTokens);
  const writes = splitCacheWrites(count(u.cacheWriteInputTokens), byTtl("5m"), byTtl("1h"));
  return {
    input,
    cachedInput,
    ...writes,
    output: count(u.outputTokens),
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

export function bedrockPlugin(env: BedrockEnv, fetcher: typeof fetch = fetch, now: () => Date = () => new Date()): ProviderPlugin {
  const region = regionOf(env);

  const setupLink = (externalId: string): string | undefined =>
    env.BEDROCK_TEMPLATE_URL && env.AWS_APP_ROLE_ARN
      ? quickCreateLink({ region, templateUrl: env.BEDROCK_TEMPLATE_URL, appRoleArn: env.AWS_APP_ROLE_ARN, externalId })
      : undefined;

  const modelId = (model: string, location: string): string => {
    const id = BEDROCK_MODEL_IDS[model] ?? model;
    if (location === "global") return `global.${id}`;
    if (location === "cross-region") return `${geography(region)}.${id}`;
    return id;
  };

  const connect: ConnectMethod = {
    guide: {
      name: "Amazon Bedrock",
      short: "Bedrock",
      vendor: "AWS",
      recommendedForFriends: true,
      steps: [
        "An AWS account with a payment method for Marketplace purchases.",
        "Type your 12-digit AWS account ID (not secret) and tap <strong>Connect Amazon Bedrock</strong>: AWS opens a ready-filled stack.",
        'Scroll to the bottom and tick <strong>"I acknowledge that AWS CloudFormation might create IAM resources with custom names."</strong> This is for the one invoke-only role, chief-of-staff-model-caller.',
        "Press <strong>Create stack</strong>.",
        "Wait until the stack's status reads CREATE_COMPLETE, which takes about a minute.",
        "Go back to the COS tab and finish the Connect step so the test call runs.",
        "Enable each model you pick once in the Bedrock console (Model access). Enable Claude Haiku 5.5 too, even if you want other model families: the Connect test call runs on it today. For Claude models older than Claude Opus 4.7, AWS also asks its one-time use-case form.",
        "The form is expected and is filled once per AWS account (or once in an AWS Organization's management account). An individual may enter their own name, a personal site or GitHub profile as the website, and a plain personal use case.",
        "The app checks the connection and runs the test call by itself.",
      ],
      checkedOn: "2026-11-26",
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
    testModel: "Claude Haiku 5.5",
    knownModels: Object.keys(BEDROCK_MODEL_IDS),
    // Converse speaks every model family, but the call needs Bedrock's own ID
    // for the model, read from its model card. A model the app has no ID for
    // is not offered yet (the shortfall above), until its ID is added.
    canCall: (model) => model in BEDROCK_MODEL_IDS,
    notCallableReason: "the app has no Bedrock ID for it",
    // Converse's reply does not name the model.
    replyModel: () => undefined,
    // The 5.5 models have no in-Region ID ("N/A" on their cards): Global, or
    // the cross-Region profile of the app's own geography.
    locations: () => ["global", "cross-region"],
    locationLabel: (location) => (location === "global" ? "Global" : location === "cross-region" ? `${geography(region).toUpperCase()} cross-Region` : location),
    modelId,
    testRequest: () => ({ messages: [{ role: "user", content: [{ text: TEST_PROMPT }] }], inferenceConfig: { maxTokens: TEST_MAX_TOKENS } }),
    replyText(body) {
      const content = (body as { output?: { message?: { content?: Array<{ text?: string }> } } } | null)?.output?.message?.content;
      const text = Array.isArray(content) ? content.map((c) => c?.text ?? "").join("").trim() : "";
      return text || undefined;
    },
    classify(f: Failure, connection: ConnectionFields | undefined) {
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
    async call({ credential, model, location, request }) {
      const id = modelId(model, location);
      const callRegion = location === "global" || location === "cross-region" ? region : location;
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
