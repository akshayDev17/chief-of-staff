// The Google Vertex AI plug-in (design-v3 1.6, T16). Google's pages now also
// call Vertex AI "Gemini Enterprise Agent Platform"; the API hosts are the same.
//
// Connect: the user types their project ID, makes the one-permission role
// with the Cloud Shell command shown, and grants it in IAM → Grant access to
// the app's service account (in the owner's project). No key file exists
// anywhere. The record holds the project ID, not secret.
//
// Credential: the issuer's ID token -> Google's STS (Workload Identity
// Federation, the owner's pool trusting the issuer) -> generateAccessToken
// for the app's service account: a 1-hour token.
//
// Caller: Claude's `rawPredict` on the user's project, at the location the
// app picks: `https://aiplatform.googleapis.com` for `global`,
// `https://aiplatform.<us|eu>.rep.googleapis.com` for the multi-regions,
// `https://<region>-aiplatform.googleapis.com` for a region. The reply is in
// Anthropic's Messages format (anthropic.ts). Gemini (T17): `generateContent`
// at `publishers/google/models/<id>` on the same hosts, its usage in
// `usageMetadata` (`promptTokenCount` with the cached part in
// `cachedContentTokenCount`, `candidatesTokenCount` and `thoughtsTokenCount`
// for output) and the model that answered in `modelVersion`. The Gemini
// caller follows Gemini's generateContent format and is checked live in M2
// step 3 (T10); a model of any other publisher is not called yet.
//
// Pages read 2026-11-25 (Google shows no page dates; every
// cloud.google.com address redirects to docs.cloud.google.com):
// - STS token: POST https://sts.googleapis.com/v1/token, grantType
//   "urn:ietf:params:oauth:grant-type:token-exchange", "do not send the
//   Authorization HTTP header"; a JWT subject token's `alg` "Must be RS256 or
//   ES256", with `kid`.
//   https://docs.cloud.google.com/iam/docs/reference/sts/rest/v1/TopLevel/token
// - generateAccessToken: projects/-/serviceAccounts/{email} ("replacing it
//   with a project ID is invalid"); "By default, the maximum allowed value is
//   1 hour."
//   https://docs.cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken
// - Provider audiences: "If this list is empty, the OIDC token audience must
//   be equal to the full canonical resource name".
//   https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.locations.workloadIdentityPools.providers
// - Claude: rawPredict, `anthropic_version` "vertex-2023-10-16"; multi-region
//   hosts aiplatform.us.rep.googleapis.com and aiplatform.eu.rep.googleapis.com,
//   "Multi-region endpoints support all Claude models with versions 4.7 and
//   later"; "To use the global endpoint, set the region to global".
//   https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/use-claude
//   https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/use-partner-models
// - Custom role: "create a custom role with the aiplatform.endpoints.predict
//   permission".
//   https://docs.cloud.google.com/vertex-ai/docs/general/access-control
// - Errors: {"error": {"code", "message", "status"}}, PERMISSION_DENIED 403,
//   NOT_FOUND 404, RESOURCE_EXHAUSTED 429. https://google.aip.dev/193
//
// Price source: Google's Cloud Billing Catalog API (src/prices/google.ts).

import { AppNotConfigured, mintIdToken, readIssuer } from "../issuer";
import type { ConnectionFields, ConnectMethod, Failure, Link, ProviderPlugin } from "../proxy/plugin";
import { ProviderRefusal } from "../proxy/plugin";
import { esc } from "../prices/page";
import { VERTEX_LOCATIONS } from "./vertex-locations";
import type { Usage } from "../proxy/plugin";
import { errorFromBody, messagesModel, messagesText, readBody, TEST_MAX_TOKENS, TEST_PROMPT, usageFromMessages } from "./anthropic";

export interface VertexEnv {
  APP_ORIGIN?: string;
  ISSUER_KEYS?: string;
  // `//iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` (T10).
  GOOGLE_WIF_PROVIDER?: string;
  // The app's service account in the owner's project (T10; not secret).
  GOOGLE_SERVICE_ACCOUNT?: string;
}

export const GOOGLE_SUBJECT = "chief-of-staff:vertex";
export const CUSTOM_ROLE_ID = "chiefOfStaffModelCaller";
const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";
const ANTHROPIC_VERSION = "vertex-2023-10-16";

// The ID token's audience: the provider's full canonical name, which Google
// accepts "with or without the https:// prefix".
export const wifAudience = (provider: string): string => `https:${provider}`;

// Vertex AI's model ID from the price table's name ("Claude Sonnet 5.5" ->
// "claude-sonnet-5-5").
export const vertexModelId = (model: string): string => model.trim().toLowerCase().replace(/[\s.]+/g, "-");

// Gemini's IDs keep the version's dots ("Gemini 3.5 Flash" -> "gemini-3.5-flash").
export const geminiModelId = (model: string): string => model.trim().toLowerCase().replace(/\s+/g, "-");

export const isGemini = (model: string): boolean => /^gemini\b/i.test(model.trim());
const isClaude = (model: string): boolean => /^claude\b/i.test(model.trim());

const host = (location: string): string =>
  location === "global" ? "aiplatform.googleapis.com" : location === "us" || location === "eu" ? `aiplatform.${location}.rep.googleapis.com` : `${location}-aiplatform.googleapis.com`;

export const generateContentUrl = (projectId: string, location: string, modelId: string): string =>
  `https://${host(location)}/v1/projects/${encodeURIComponent(projectId)}/locations/${location}/publishers/google/models/${encodeURIComponent(modelId)}:generateContent`;

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

// Gemini's long-context threshold was not read for this ticket: a prompt
// over 200,000 tokens is costed at the long-prompt rows (or, where the table
// lists none, at the dearest rate, proxy.ts), so a call is never costed
// below what Google can charge. Checked live in M2 step 3 (T10).
const GEMINI_LONG_PROMPT_OVER = 200_000;

export function usageFromGemini(body: unknown): Usage | undefined {
  const u = (body as { usageMetadata?: Record<string, unknown> } | null)?.usageMetadata;
  if (!u || typeof u !== "object") return undefined;
  const prompt = count(u.promptTokenCount);
  const cachedInput = Math.min(prompt, count(u.cachedContentTokenCount));
  return {
    input: prompt - cachedInput,
    cachedInput,
    cacheWrite: 0,
    cacheWrite1h: 0,
    output: count(u.candidatesTokenCount) + count(u.thoughtsTokenCount),
    longPrompt: prompt > GEMINI_LONG_PROMPT_OVER,
  };
}

export function geminiText(body: unknown): string | undefined {
  const parts = (body as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> } | null)?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("").trim() : "";
  return text || undefined;
}

export function rawPredictUrl(projectId: string, location: string, modelId: string): string {
  return `https://${host(location)}/v1/projects/${encodeURIComponent(projectId)}/locations/${location}/publishers/anthropic/models/${encodeURIComponent(modelId)}:rawPredict`;
}

// The one-line Cloud Shell command that makes the role holding only the
// permission a model call needs.
export const customRoleCommand = (projectId: string): string =>
  `gcloud iam roles create ${CUSTOM_ROLE_ID} --project=${projectId} --title="Chief of staff model caller" --permissions=aiplatform.endpoints.predict`;

const consoleLink = (path: string, projectId: string | undefined): string =>
  `https://console.cloud.google.com/${path}${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`;

async function googleJson(response: Response, step: string): Promise<Record<string, unknown>> {
  const body = await readBody(response);
  if (!response.ok) {
    const { name, message } = errorFromBody(response.status, body);
    throw new ProviderRefusal({ step, status: response.status, errorName: name, message });
  }
  return (body ?? {}) as Record<string, unknown>;
}

export function vertexPlugin(env: VertexEnv, fetcher: typeof fetch = fetch, now: () => Date = () => new Date()): ProviderPlugin {
  const serviceAccount = env.GOOGLE_SERVICE_ACCOUNT?.trim();

  const iamLink = (connection?: ConnectionFields): Link => ({ label: "Open IAM → Grant access", href: consoleLink("iam-admin/iam", connection?.projectId) });

  const connect: ConnectMethod = {
    guide: {
      name: "Google Vertex AI",
      short: "Vertex AI",
      vendor: "Google",
      recommendedForFriends: false,
      steps: [
        "A Google Cloud project with billing, and the Vertex AI API enabled (Google's pages now also call it “Gemini Enterprise Agent Platform”). For Claude: its Model Garden card → Enable.",
        "Type your project ID and tap <strong>Connect Google Vertex AI</strong>.",
        "Run the one-line Cloud Shell command shown, which makes a role that can only call models. If you cannot create custom roles, use Google's <strong>Vertex AI User</strong> role (<code>roles/aiplatform.user</code>) instead.",
        "In IAM → Grant access, paste the app's service-account email (copy button), pick that role and Save. No key file is made.",
      ],
      checkedOn: "2026-11-25",
      pages: [
        { label: "Use Claude on Vertex AI", href: "https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/use-claude" },
        { label: "Vertex AI access control", href: "https://docs.cloud.google.com/vertex-ai/docs/general/access-control" },
        { label: "Workload Identity Federation", href: "https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers" },
      ],
      revoke: "remove the app's service account from your project in IAM.",
      regionChoice: true,
    },
    fields: [
      {
        name: "projectId",
        label: "Project ID",
        placeholder: "example-project-123",
        pattern: "[a-z][a-z0-9-]{4,28}[a-z0-9]",
        problem: "A project ID is 6 to 30 lowercase letters, digits or hyphens, starting with a letter.",
      },
    ],
    start: (typed) => ({ kind: "connection", fields: { projectId: typed.projectId! } }),
    grantHelp(connection) {
      const account = serviceAccount
        ? `<span class="mono">${esc(serviceAccount)}</span> <button type="button" class="btn small ghost" data-copy="${esc(serviceAccount)}">Copy</button>`
        : `<span class="muted">shown once Admin has set up the app's Google identity</span>`;
      return `<p class="small">The app's service account: ${account}</p>
<p class="small">The Cloud Shell command${connection?.projectId ? "" : " (put your project ID in it)"}:</p>
<pre class="cmd">${esc(customRoleCommand(connection?.projectId ?? "YOUR_PROJECT_ID"))}</pre>`;
    },
    testModel: "Claude Haiku 5.5",
    knownModels: Object.keys(VERTEX_LOCATIONS),
    canCall: (model) => isClaude(model) || isGemini(model),
    locations: (model) => [...(VERTEX_LOCATIONS[model] ?? ["global"])],
    locationLabel: (location) => (location === "global" ? "Global" : location === "us" ? "US multi-region" : location === "eu" ? "EU multi-region" : location),
    modelId: (model) => (isGemini(model) ? geminiModelId(model) : vertexModelId(model)),
    testRequest: (model) =>
      isGemini(model)
        ? { contents: [{ role: "user", parts: [{ text: TEST_PROMPT }] }], generationConfig: { maxOutputTokens: TEST_MAX_TOKENS } }
        : { anthropic_version: ANTHROPIC_VERSION, max_tokens: TEST_MAX_TOKENS, messages: [{ role: "user", content: TEST_PROMPT }] },
    replyText: (body) => messagesText(body) ?? geminiText(body),
    replyModel: (body) => {
      const version = (body as { modelVersion?: unknown } | null)?.modelVersion;
      return typeof version === "string" && version ? version : messagesModel(body);
    },
    classify(f: Failure, connection) {
      const said = `${f.errorName} ${f.message}`;
      if (f.step === "credential") {
        return { reason: "app_not_configured", fix: "Google did not accept the app's own identity: Admin's one-time Google step needs checking.", links: [] };
      }
      if (/Model Garden|not enabled for this project|enable the model|terms of service/i.test(said)) {
        return {
          reason: "not_allowed_yet",
          fix: "Enable the model once on its Model Garden card, then try again.",
          links: [{ label: "Open Model Garden", href: consoleLink("vertex-ai/model-garden", connection?.projectId) }],
        };
      }
      if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(said)) {
        return {
          reason: "not_allowed_yet",
          fix: "Enable the Vertex AI API (aiplatform.googleapis.com) on the project, then try again.",
          links: [{ label: "Open the Vertex AI API", href: consoleLink("apis/library/aiplatform.googleapis.com", connection?.projectId) }],
        };
      }
      if (/BILLING|billing/.test(said)) {
        return { reason: "not_allowed_yet", fix: "Turn on billing for the project, then try again.", links: [{ label: "Open Billing", href: consoleLink("billing/linkedaccount", connection?.projectId) }] };
      }
      if (f.status === 401 || f.status === 403 || /PERMISSION_DENIED|UNAUTHENTICATED/.test(f.errorName)) {
        return { reason: "not_set_up", fix: "Grant the app's service account its role on your project (the one the Cloud Shell command made, else Vertex AI User, roles/aiplatform.user), then try again.", links: [iamLink(connection)] };
      }
      if (f.status === 404 || /NOT_FOUND/.test(f.errorName)) {
        return { reason: "no_such_model", fix: "Change the region, or pick a model the project offers there.", links: [] };
      }
      if (f.status === 429 || /RESOURCE_EXHAUSTED/.test(f.errorName)) return { reason: "busy", fix: "Nothing to set up: try again in a minute.", links: [] };
      return { reason: "refused", fix: "Google's own words above say why.", links: [] };
    },
  };

  return {
    provider: "vertex",
    version: "vertex-1.0.0",
    connectionFields: ["projectId"],
    priceSource: ["google-catalog"],
    connect,
    async mintCredential() {
      const missing = [...(env.GOOGLE_WIF_PROVIDER ? [] : ["GOOGLE_WIF_PROVIDER"]), ...(serviceAccount ? [] : ["GOOGLE_SERVICE_ACCOUNT"])];
      if (missing.length) throw new AppNotConfigured(missing);
      const issuer = await readIssuer(env);
      const subjectToken = await mintIdToken(issuer, { audience: wifAudience(env.GOOGLE_WIF_PROVIDER!), subject: GOOGLE_SUBJECT, now: now() });
      const federated = await googleJson(
        await fetcher("https://sts.googleapis.com/v1/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
            audience: env.GOOGLE_WIF_PROVIDER,
            scope: CLOUD_PLATFORM,
            requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
            subjectToken,
            subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
          }),
        }),
        "sts.googleapis.com token",
      );
      if (typeof federated.access_token !== "string") throw new Error("Google's STS answered without a token");
      const token = await googleJson(
        await fetcher(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount!)}:generateAccessToken`, {
          method: "POST",
          headers: { authorization: `Bearer ${federated.access_token}`, "content-type": "application/json" },
          body: JSON.stringify({ scope: [CLOUD_PLATFORM], lifetime: "3600s" }),
        }),
        "generateAccessToken",
      );
      if (typeof token.accessToken !== "string") throw new Error("generateAccessToken answered without a token");
      return { accessToken: token.accessToken, expireTime: token.expireTime };
    },
    async call({ credential, connection, model, location, request }) {
      const authorization = `Bearer ${(credential as { accessToken: string }).accessToken}`;
      if (isGemini(model)) {
        const response = await fetcher(generateContentUrl(connection.projectId!, location, geminiModelId(model)), {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        const reply = await readBody(response);
        if (!response.ok) return { status: response.status, body: reply, error: errorFromBody(response.status, reply) };
        return { status: response.status, body: reply, usage: usageFromGemini(reply) };
      }
      const id = vertexModelId(model);
      // The model is in the address, not the body.
      const body: Record<string, unknown> = { anthropic_version: ANTHROPIC_VERSION, ...(request as Record<string, unknown>) };
      delete body.model;
      const response = await fetcher(rawPredictUrl(connection.projectId!, location, id), {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const reply = await readBody(response);
      if (!response.ok) return { status: response.status, body: reply, error: errorFromBody(response.status, reply) };
      return { status: response.status, body: reply, usage: usageFromMessages(reply, id) };
    },
  };
}
