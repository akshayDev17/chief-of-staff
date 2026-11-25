// The Microsoft Foundry plug-in (design-v3 1.6, T16).
//
// Connect: the user types their Foundry resource address and taps Connect
// Microsoft Foundry; Microsoft's admin-consent page adds the app's
// multi-tenant Entra registration ("Chief of staff", in the owner's tenant)
// to the user's tenant and comes back with the tenant ID. The user then gives
// "Chief of staff" a role on the resource and turns off key authentication.
// The record holds the tenant ID and the endpoint, neither secret.
//
// Credential: client credentials in the user's tenant, scope
// `https://ai.azure.com/.default`, the app proving itself with its
// certificate (a signed client assertion; the private key is the Worker
// secret ENTRA_CERT_KEY). FOUNDRY_CREDENTIAL=federated switches to a
// federated credential on the app's own issuer instead, if M2 step 11.1
// shows that works across tenants. Tokens last 60 to 90 minutes, with no
// refresh token.
//
// Caller: Claude at `<endpoint>/anthropic/v1/messages`, the deployment name as
// `model`, `Authorization: Bearer`, `anthropic-version: 2023-06-01`. Every
// other chat model Foundry sells (GPT, gpt-oss, DeepSeek, Grok, Llama,
// Mistral and the rest, T17) at `<endpoint>/openai/v1/chat/completions`, the
// deployment name as `model`, in OpenAI's Chat Completions format: usage
// `prompt_tokens` with the cached part in `prompt_tokens_details.cached_tokens`,
// `completion_tokens` with any reasoning tokens in it, and
// `max_completion_tokens` (reasoning models refuse `max_tokens`). This
// caller was built from that format, not yet from a Foundry page read for
// this ticket: its address and fields are checked live in M2 step 3 (T10).
//
// The deployment name is the user's: the guide asks them to keep the
// suggested one, the model ID, which Add a model fills in; a user who named
// the deployment differently changes it there (T17).
//
// Pages read 2026-11-25 (ms.date in brackets):
// - Client credentials [2026-01-30]: POST /{tenant}/oauth2/v2.0/token;
//   `client_assertion_type` "must be set to
//   urn:ietf:params:oauth:client-assertion-type:jwt-bearer"; admin consent at
//   /{tenant}/adminconsent?client_id=&state=&redirect_uri=, returning
//   `tenant`, `state`, `admin_consent`, or `error` and `error_description`.
//   https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow
// - Certificate credentials [2025-01-04]: `alg` "Should be PS256", `x5t#S256`
//   the "Base64url-encoded SHA-256 thumbprint of the X.509 certificate's DER
//   encoding", `aud` the token endpoint, `iss` and `sub` the client ID, `exp`
//   "5-10 minutes after nbf at most".
//   https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials
// - Admin consent [2023-11-08]: "Do not use 'common', as personal accounts
//   cannot provide admin consent except in the context of a tenant."
//   https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent
// - Federated credentials [2024-12-13]: audience "api://AzureADTokenExchange".
//   https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust
// - Claude on Foundry [2026-09-21] (endpoint, headers, troubleshooting rows)
//   and keyless Entra [2026-08-31]: "Tokens must be issued with scope
//   https://ai.azure.com/.default."
//   https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/use-foundry-models-claude
//   https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/configure-entra-id
// - Disable local authentication [2026-05-31]: "set the property
//   disableLocalAuth to true".
//   https://learn.microsoft.com/en-us/azure/ai-services/disable-local-auth
// - Entra error codes [2025-02-03]: AADSTS700016 "The application wasn't found
//   in the directory/tenant", AADSTS65001, AADSTS90094 "Administrator consent
//   is required", AADSTS500011, AADSTS700027 "Client assertion failed signature
//   validation".
//   https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes
//
// Price source: Azure's Retail Prices API and the maintainers' reading of
// Claude's Marketplace listings (src/prices/azure.ts, maintainer.ts).

import { AppNotConfigured, mintIdToken, readIssuer, signJwt } from "../issuer";
import { PROVIDERS_PATH } from "../paths";
import type { ConnectMethod, Failure, Link, ProviderPlugin } from "../proxy/plugin";
import { ConnectProblem, ProviderRefusal } from "../proxy/plugin";
import type { Usage } from "../proxy/plugin";
import { errorFromBody, messagesModel, messagesText, readBody, TEST_MAX_TOKENS, TEST_PROMPT, usageFromMessages } from "./anthropic";

export interface FoundryEnv {
  APP_ORIGIN?: string;
  ISSUER_KEYS?: string;
  // The multi-tenant Entra app's client (application) ID (T10; not secret).
  ENTRA_CLIENT_ID?: string;
  // The certificate's private key, PKCS #8 PEM (Worker secret, T10).
  ENTRA_CERT_KEY?: string;
  // The certificate's x5t#S256 thumbprint, base64url (not secret).
  ENTRA_CERT_THUMBPRINT?: string;
  // "certificate" (the default) or "federated".
  FOUNDRY_CREDENTIAL?: string;
}

export const FOUNDRY_SCOPE = "https://ai.azure.com/.default";
export const ENTRA_FEDERATED_AUDIENCE = "api://AzureADTokenExchange";
export const ENTRA_SUBJECT = "chief-of-staff:foundry";
export const CONSENT_RETURN_PATH = `${PROVIDERS_PATH}/foundry/consented`;
const ANTHROPIC_VERSION = "2023-06-01";
const LOGIN = "https://login.microsoftonline.com";
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const ASSERTION_LIFETIME_S = 300;

// `https://<resource>.services.ai.azure.com`, the address Claude's page gives.
const ENDPOINT = /^https:\/\/[a-z0-9][a-z0-9-]{1,62}\.services\.ai\.azure\.com\/?$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude is called in Anthropic's Messages format; every other model in
// Chat Completions.
export const isClaude = (model: string): boolean => /^claude\b/i.test(model.trim());

// Foundry's own IDs for the models the app knows, by the price table's names,
// from Microsoft's catalog pages, each ID as the page prints it (ms.date
// 2026-09-21, updated 2026-11-24, read in full 2026-11-25):
// - Claude: "Foundry Models from partners and community", the Claude table.
//   https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/concepts/models-from-partners
// - Every other model: "Foundry Models sold directly by Azure".
//   https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/concepts/models-sold-directly-by-azure
// The ID is the deployment name the guide asks the user to keep ("By
// default, the deployment uses the model name"). A price-table name is mapped
// only where the page names exactly one ID plainly for the same model. A
// model the table prices but this map leaves out cannot be picked: a
// Fireworks or Baseten row, a retired or dated version, and a meter whose
// catalog ID would be a guess ("DeepSeek V3.2 SP", "Mistral MM3.5",
// "Mistral Codestral", "Grok 4.1", "Grok 4.2", "Grok4 Fast",
// "Kimi K2.5 Thinking", "Kimi K2.6 Thinking", "GPT 5.2 pro", "Code 1.1 Flash"
// (the page lists MAI-Code-1.1-Flash only as a fine-tuning base), the dated
// gpt-4o and GPT-chat-latest rows).
export const FOUNDRY_MODEL_IDS: Readonly<Record<string, string>> = {
  "Claude Haiku 5.5": "claude-haiku-5-5",
  "Claude Sonnet 5.5": "claude-sonnet-5-5",
  "Claude Opus 5.5": "claude-opus-5-5",
  "Claude Sonnet 5": "claude-sonnet-5",
  "Claude Opus 5": "claude-opus-5",
  "Claude Fable 5.1": "claude-fable-5-1",
  "Claude Fable 5": "claude-fable-5",
  "Claude Opus 4.8": "claude-opus-4-8",
  "Claude Opus 4.7": "claude-opus-4-7",
  "Claude Opus 4.6": "claude-opus-4-6",
  "Claude Sonnet 4.6": "claude-sonnet-4-6",
  "Claude Haiku 4.5": "claude-haiku-4-5",
  "GPT-6.2-astra": "gpt-6.2-astra",
  "GPT-6.2-sol": "gpt-6.2-sol",
  "GPT-6.1-sol": "gpt-6.1-sol",
  "GPT-6.1-terra": "gpt-6.1-terra",
  "GPT-6-astra": "gpt-6-astra",
  "GPT-6-luna": "gpt-6-luna",
  "GPT-6-sol": "gpt-6-sol",
  "GPT-5.6-sol": "gpt-5.6-sol",
  "GPT-5.6-terra": "gpt-5.6-terra",
  "GPT-5.6-luna": "gpt-5.6-luna",
  "GPT-5.5": "gpt-5.5",
  "GPT-5.4": "gpt-5.4",
  "GPT-5.4 pro": "gpt-5.4-pro",
  "GPT-5.4 mini": "gpt-5.4-mini",
  "GPT-5.4 nano": "gpt-5.4-nano",
  "GPT-5.3 codex": "gpt-5.3-codex",
  "GPT-5.2 codex": "gpt-5.2-codex",
  "GPT 5.2": "gpt-5.2",
  "GPT 5.1": "gpt-5.1",
  "GPT-5.1 codex": "gpt-5.1-codex",
  "GPT-5.1 codex mini": "gpt-5.1-codex-mini",
  "GPT-5.1 codex max": "gpt-5.1-codex-max",
  "GPT 5": "gpt-5",
  "GPT 5 Mini": "gpt-5-mini",
  "GPT 5 Nano": "gpt-5-nano",
  "gpt-5-codex": "gpt-5-codex",
  "gpt 5 pro": "gpt-5-pro",
  "gpt-oss-120B": "gpt-oss-120b",
  "gpt 4.1": "gpt-4.1",
  "gpt 4.1 mini": "gpt-4.1-mini",
  "gpt 4.1 nano": "gpt-4.1-nano",
  "codex mini": "codex-mini",
  "o3-pro": "o3-pro",
  "o4-mini 0416": "o4-mini",
  "o3 0416": "o3",
  "o3 mini 0131": "o3-mini",
  "o1 1217": "o1",
  "o1 mini": "o1-mini",
  "DeepSeek V4.1 Flash": "DeepSeek-V4.1-Flash",
  "DeepSeek V4 Pro": "DeepSeek-V4-Pro",
  "DeepSeek V4 Flash 0731": "DeepSeek-V4-Flash-0731",
  "DeepSeek V4 Flash": "DeepSeek-V4-Flash",
  "DeepSeek V3.2": "DeepSeek-V3.2",
  "Grok 4.7": "grok-4.7",
  "Grok 4.6": "grok-4.6",
  "Grok 4.3": "grok-4.3",
  "Grok-4": "grok-4",
  "Grok Code Fast 1": "grok-code-fast-1",
  "Kimi 3.1 Pro": "Kimi-K3.1-Pro",
  "Kimi K2.7 Code": "Kimi-K2.7-Code",
  "Kimi K2.6": "Kimi-K2.6",
  "Kimi K2.5": "Kimi-K2.5",
  "Mistral Large 4": "mistral-large-4-latest",
  "Mistral Large 3": "Mistral-Large-3",
  "Llama 4 Maverick 17B": "Llama-4-Maverick-17B-128E-Instruct-FP8",
  "Llama 3.3 70B": "Llama-3.3-70B-Instruct",
  "Cohere Command A Plus": "Cohere-command-a-plus-05-2026",
  "Cohere Command A": "Cohere-command-a",
  "MAI-Thinking-1": "MAI-Thinking-1",
};

// The deployment name the guide asks the user to keep: the model's ID.
export const deploymentName = (model: string): string | undefined => FOUNDRY_MODEL_IDS[model];

const foundryModelId = (model: string): string => FOUNDRY_MODEL_IDS[model] ?? model;

// The Claude models Foundry sells (through Azure Marketplace, priced by the
// maintainers' reading of each listing, shell/prices/maintainer-read.json):
// offered on Add a model, as "no price yet" until that reading is recorded.
export const FOUNDRY_CLAUDE_MODELS: readonly string[] = Object.keys(FOUNDRY_MODEL_IDS).filter(isClaude);

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

// Usage from a Chat Completions reply: `prompt_tokens` includes the cached
// part, which the proxy counts on its own. Foundry lists no long-prompt rate
// for these models.
export function usageFromChatCompletions(body: unknown): Usage | undefined {
  const u = (body as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u !== "object") return undefined;
  const prompt = count(u.prompt_tokens);
  const cachedInput = Math.min(prompt, count((u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens));
  return { input: prompt - cachedInput, cachedInput, cacheWrite: 0, cacheWrite1h: 0, output: count(u.completion_tokens), longPrompt: false };
}

export function chatCompletionsText(body: unknown): string | undefined {
  const choices = (body as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices;
  const content = Array.isArray(choices) ? choices[0]?.message?.content : undefined;
  return typeof content === "string" && content.trim() ? content.trim() : undefined;
}

export function adminConsentLink(input: { clientId: string; appOrigin: string; state: string }): string {
  // `organizations`, never `common`: admin consent happens in a tenant.
  const q = new URLSearchParams({ client_id: input.clientId, redirect_uri: `${input.appOrigin}${CONSENT_RETURN_PATH}`, state: input.state });
  return `${LOGIN}/organizations/adminconsent?${q}`;
}

async function importPkcs8(pem: string): Promise<CryptoKey> {
  const base64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
}

// The signed client assertion that proves the app is itself.
export async function certificateAssertion(input: { clientId: string; tenantId: string; keyPem: string; thumbprint: string; now: Date }): Promise<string> {
  const iat = Math.floor(input.now.getTime() / 1000);
  return signJwt(
    { alg: "PS256", typ: "JWT", "x5t#S256": input.thumbprint },
    { aud: `${LOGIN}/${input.tenantId}/oauth2/v2.0/token`, iss: input.clientId, sub: input.clientId, jti: crypto.randomUUID(), nbf: iat, iat, exp: iat + ASSERTION_LIFETIME_S },
    await importPkcs8(input.keyPem),
    { name: "RSA-PSS", saltLength: 32 },
  );
}

// Entra's refusal: `error`, `error_description`, `error_codes`.
function entraRefusal(status: number, body: unknown): ProviderRefusal {
  const b = (body ?? {}) as { error?: unknown; error_description?: unknown; error_codes?: unknown };
  const code = Array.isArray(b.error_codes) && typeof b.error_codes[0] === "number" ? `AADSTS${b.error_codes[0]}` : undefined;
  const description = typeof b.error_description === "string" ? b.error_description.split(/\r?\n/)[0]! : "";
  return new ProviderRefusal({ step: "token", status, errorName: code ?? (typeof b.error === "string" ? b.error : `HTTP ${status}`), message: description });
}

const PORTAL_RESOURCES: Link = { label: "Open your resource's Access control", href: "https://portal.azure.com/#browse/Microsoft.CognitiveServices%2Faccounts" };
const PORTAL_ENTERPRISE_APPS: Link = { label: "Open your Enterprise applications", href: "https://portal.azure.com/#view/Microsoft_AAD_IAM/StartboardApplicationsMenuBlade/~/AppAppsPreview" };

export function foundryPlugin(env: FoundryEnv, fetcher: typeof fetch = fetch, now: () => Date = () => new Date()): ProviderPlugin {
  const connect: ConnectMethod = {
    guide: {
      name: "Microsoft Foundry",
      short: "Foundry",
      vendor: "Foundry",
      recommendedForFriends: false,
      steps: [
        "A paid Azure subscription with pay-as-you-go billing (not a free trial, student, credit-only or reseller subscription), billed in a country where Anthropic sells Claude, with a Foundry project in a region that offers the model.",
        "For Claude: Build → Catalog → Model Catalog → the model (Claude Haiku 5.5 for the test call) → Deploy → Custom settings, then accept the Marketplace terms. Keep the suggested deployment name.",
        "Type your Foundry resource address and tap <strong>Connect Microsoft Foundry</strong>: sign in on Microsoft's page and tap <strong>Accept</strong>.",
        "On your resource: Access control (IAM) → Add → Add role assignment → the role → “Chief of staff” → Review + assign.",
        "Turn off key authentication on the resource, so no key can be read from it.",
      ],
      checkedOn: "2026-11-25",
      pages: [
        { label: "Claude in Foundry", href: "https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/use-foundry-models-claude" },
        { label: "Keyless Microsoft Entra ID", href: "https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/configure-entra-id" },
        { label: "Add a role assignment", href: "https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-portal" },
        { label: "Disable key authentication", href: "https://learn.microsoft.com/en-us/azure/ai-services/disable-local-auth" },
      ],
      revoke: "remove “Chief of staff”’s role on your resource, or the app from your Enterprise applications.",
      // The deployment type is chosen when the model is deployed in Foundry.
      regionChoice: false,
    },
    fields: [
      {
        name: "endpoint",
        label: "Resource address",
        placeholder: "https://<resource>.services.ai.azure.com",
        pattern: ENDPOINT.source.slice(1, -1),
        problem: "A Foundry resource address looks like https://<resource>.services.ai.azure.com.",
      },
    ],
    start(typed, { appOrigin, consentState }) {
      if (!env.ENTRA_CLIENT_ID) throw new AppNotConfigured(["ENTRA_CLIENT_ID"]);
      const endpoint = typed.endpoint!.replace(/\/+$/, "");
      return { kind: "consent", pending: { endpoint }, open: adminConsentLink({ clientId: env.ENTRA_CLIENT_ID, appOrigin, state: consentState }) };
    },
    finish(pending, returned) {
      const error = returned.get("error");
      if (error) {
        throw new ConnectProblem(`Microsoft's consent page did not accept: ${returned.get("error_description") || error}`);
      }
      const tenantId = returned.get("tenant") ?? "";
      if (returned.get("admin_consent")?.toLowerCase() !== "true" || !GUID.test(tenantId)) {
        throw new ConnectProblem("Microsoft's consent page did not say the app was accepted. Tap Connect Microsoft Foundry again.");
      }
      // The tenant only names where the app asks for its tokens; the token
      // request itself proves the consent.
      return { tenantId: tenantId.toLowerCase(), endpoint: pending.endpoint! };
    },
    testModel: "Claude Haiku 5.5",
    knownModels: FOUNDRY_CLAUDE_MODELS,
    canCall: (model) => model in FOUNDRY_MODEL_IDS,
    deploymentName,
    locations: () => ["global", "data-zone"],
    locationLabel: (location) => (location === "global" ? "Global Standard" : location === "data-zone" ? "Data Zone Standard" : location),
    modelId: foundryModelId,
    testRequest: (model) =>
      isClaude(model)
        ? { model: foundryModelId(model), max_tokens: TEST_MAX_TOKENS, messages: [{ role: "user", content: TEST_PROMPT }] }
        : { model: foundryModelId(model), max_completion_tokens: TEST_MAX_TOKENS, messages: [{ role: "user", content: TEST_PROMPT }] },
    replyText: (body) => messagesText(body) ?? chatCompletionsText(body),
    replyModel: messagesModel,
    classify(f: Failure) {
      const said = `${f.errorName} ${f.message}`;
      if (f.step === "credential") {
        if (/AADSTS(700016|700011|65001|90094|500011)\b/.test(f.errorName)) {
          return {
            reason: "not_set_up",
            fix: "Tap Connect Microsoft Foundry and accept on Microsoft's page, then try again.",
            links: [PORTAL_ENTERPRISE_APPS],
          };
        }
        if (/AADSTS(700027|700030|7000215|700024)\b|invalid_client/.test(said)) {
          return { reason: "app_not_configured", fix: "Microsoft did not accept the app's own credential: Admin's one-time Microsoft step needs checking.", links: [] };
        }
        return { reason: "refused", fix: "Microsoft's own words above say why.", links: [] };
      }
      if (/data retention|zero data retention|\bZDR\b/i.test(said)) {
        return {
          reason: "data_retention",
          fix: "This model needs data retention, which your subscription has turned off. Microsoft's fix is a new subscription, where it is on by default.",
          links: [],
        };
      }
      if (/region/i.test(said) && /not available|unsupported|not supported/i.test(said)) {
        return { reason: "region_unavailable", fix: "Deploy the model in a region that offers it, then try again.", links: [] };
      }
      if (/subscription (type|tier)|billing region|quota of 0|not eligible|eligibility/i.test(said)) {
        return {
          reason: "not_allowed_yet",
          fix: "The subscription must be pay-as-you-go, billed in a country where Anthropic sells Claude, with quota for the model.",
          links: [],
        };
      }
      if (f.status === 401 || f.status === 403) {
        return { reason: "not_set_up", fix: "Give “Chief of staff” its role on your Foundry resource, then try again.", links: [PORTAL_RESOURCES] };
      }
      if (f.status === 404) {
        return { reason: "no_such_model", fix: "Deploy the model from the catalog and keep the name Foundry suggests for it, then try again.", links: [] };
      }
      if (f.status === 429 || f.status === 503) return { reason: "busy", fix: "Nothing to set up: try again in a minute.", links: [] };
      return { reason: "refused", fix: "Foundry's own words above say why.", links: [] };
    },
  };

  return {
    provider: "foundry",
    version: "foundry-1.0.0",
    connectionFields: ["tenantId", "endpoint"],
    priceSource: ["azure-retail", "maintainer-read"],
    connect,
    async mintCredential(connection) {
      const clientId = env.ENTRA_CLIENT_ID;
      const federated = env.FOUNDRY_CREDENTIAL === "federated";
      const missing = [
        ...(clientId ? [] : ["ENTRA_CLIENT_ID"]),
        ...(federated ? [] : [...(env.ENTRA_CERT_KEY ? [] : ["ENTRA_CERT_KEY"]), ...(env.ENTRA_CERT_THUMBPRINT ? [] : ["ENTRA_CERT_THUMBPRINT"])]),
      ];
      if (missing.length) throw new AppNotConfigured(missing);
      const at = now();
      const tenantId = connection.tenantId!;
      const assertion = federated
        ? await mintIdToken(await readIssuer(env), { audience: ENTRA_FEDERATED_AUDIENCE, subject: ENTRA_SUBJECT, now: at })
        : await certificateAssertion({ clientId: clientId!, tenantId, keyPem: env.ENTRA_CERT_KEY!, thumbprint: env.ENTRA_CERT_THUMBPRINT!, now: at });
      const response = await fetcher(`${LOGIN}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId!,
          scope: FOUNDRY_SCOPE,
          client_assertion_type: ASSERTION_TYPE,
          client_assertion: assertion,
          grant_type: "client_credentials",
        }).toString(),
      });
      const body = await readBody(response);
      const token = (body as { access_token?: unknown } | null)?.access_token;
      if (!response.ok || typeof token !== "string") throw entraRefusal(response.status, body);
      return { accessToken: token, expiresIn: (body as { expires_in?: number }).expires_in };
    },
    async call({ credential, connection, model, deployment, request }) {
      const name = deployment ?? foundryModelId(model);
      const claude = isClaude(model);
      const headers: Record<string, string> = { authorization: `Bearer ${(credential as { accessToken: string }).accessToken}`, "content-type": "application/json" };
      if (claude) headers["anthropic-version"] = ANTHROPIC_VERSION;
      const response = await fetcher(`${connection.endpoint}${claude ? "/anthropic/v1/messages" : "/openai/v1/chat/completions"}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...(request as object), model: name }),
      });
      const reply = await readBody(response);
      if (!response.ok) return { status: response.status, body: reply, error: errorFromBody(response.status, reply) };
      // The long-prompt rule is keyed by the model's own ID, not the user's name for it.
      return { status: response.status, body: reply, usage: claude ? usageFromMessages(reply, foundryModelId(model)) : usageFromChatCompletions(reply) };
    },
  };
}

