// The app's one keyless route into Google (design-v3 1.3 and 1.4): an ID
// token from the app's own issuer, traded at Google's STS for a federated
// access token, about an hour long, in the app's Workload Identity
// Federation pool. No service account, no service-account key and no API key
// exists anywhere.
//
// The pool admits exactly two kinds of subject (the provider's attribute
// condition, scripts/provider-setup-lib.mjs GOOGLE_SUBJECT_CONDITION):
// - a user's own app ID, a UUID (src/users.ts), for that user's own Vertex AI
//   calls (src/providers/vertex.ts);
// - PRICE_READER_SUBJECT, the price table's reader of Google's Cloud Billing
//   Catalog (src/prices/google.ts).
// "price-reader" is not a UUID, so no user's token can carry it, and the
// price reader's token carries no user's ID, so it can act as no user. The
// one exchange below is not exported: callers name a user or the price
// reader, never a subject of their own.
//
// The exchange (pages read 2026-11-25, see src/providers/vertex.ts):
// POST https://sts.googleapis.com/v1/token, grantType
// "urn:ietf:params:oauth:grant-type:token-exchange", no Authorization header;
// the JWT subject token signed RS256 with a `kid`.
// https://docs.cloud.google.com/iam/docs/reference/sts/rest/v1/TopLevel/token

import { AppNotConfigured, mintIdToken, readIssuer } from "./issuer";
import { errorFromBody, readBody } from "./providers/anthropic";
import { ProviderRefusal } from "./proxy/plugin";

export interface GoogleFederationEnv {
  APP_ORIGIN?: string;
  ISSUER_KEYS?: string;
  // `//iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` (T10).
  GOOGLE_WIF_PROVIDER?: string;
}

export interface GoogleToken {
  accessToken: string;
  expiresIn: unknown;
}

// A user's app ID as src/users.ts makes it (crypto.randomUUID()): the only
// subject a user's token ever carries.
export const USER_SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The price reader's own subject: one fixed value, never a UUID.
export const PRICE_READER_SUBJECT = "price-reader";

export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
// The narrowest of the scopes services.skus.list accepts ("Requires one of
// the following OAuth scopes": cloud-platform, cloud-billing,
// cloud-billing.readonly; read 2026-11-26).
// https://docs.cloud.google.com/billing/docs/reference/rest/v1/services.skus/list
export const CLOUD_BILLING_READONLY_SCOPE = "https://www.googleapis.com/auth/cloud-billing.readonly";

// The ID token's audience: the provider's full canonical name, which Google
// accepts "with or without the https:// prefix".
export const wifAudience = (provider: string): string => `https:${provider}`;

const WIF_PROVIDER = /^\/\/iam\.googleapis\.com\/(projects\/(\d+)\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+)\/providers\/[a-z0-9-]+$/;

const poolOf = (wifProvider: string | undefined) => WIF_PROVIDER.exec(wifProvider?.trim() ?? "");

// The app's own Google project, by number: the one that holds the pool. The
// price reader's quota project; never a user's project.
export const appProjectNumber = (wifProvider: string | undefined): string | undefined => poolOf(wifProvider)?.[2];

// The user's own Google identity, the one they grant the role to on their own
// project: the pool of GOOGLE_WIF_PROVIDER, subject the user's app ID.
// Undefined until the pool exists (T10), and for anything that is not an app ID.
export function userPrincipal(wifProvider: string | undefined, userId: string): string | undefined {
  const pool = poolOf(wifProvider)?.[1];
  return pool && USER_SUBJECT.test(userId) ? `principal://iam.googleapis.com/${pool}/subject/${userId}` : undefined;
}

// The price reader's identity, granted only the quota-project role on the
// app's own project (README "What the owner sets up").
export function priceReaderPrincipal(wifProvider: string | undefined): string | undefined {
  const pool = poolOf(wifProvider)?.[1];
  return pool ? `principal://iam.googleapis.com/${pool}/subject/${PRICE_READER_SUBJECT}` : undefined;
}

async function exchange(env: GoogleFederationEnv, fetcher: typeof fetch, now: Date, subject: string, scope: string): Promise<GoogleToken> {
  if (!env.GOOGLE_WIF_PROVIDER || !poolOf(env.GOOGLE_WIF_PROVIDER)) throw new AppNotConfigured(["GOOGLE_WIF_PROVIDER"]);
  const issuer = await readIssuer(env);
  const subjectToken = await mintIdToken(issuer, { audience: wifAudience(env.GOOGLE_WIF_PROVIDER), subject, now });
  const response = await fetcher("https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: env.GOOGLE_WIF_PROVIDER,
      scope,
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectToken,
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
    }),
  });
  const body = await readBody(response);
  if (!response.ok) {
    const { name, message } = errorFromBody(response.status, body);
    throw new ProviderRefusal({ step: "sts.googleapis.com token", status: response.status, errorName: name, message });
  }
  const token = (body ?? {}) as Record<string, unknown>;
  if (typeof token.access_token !== "string") throw new Error("Google's STS answered without a token");
  return { accessToken: token.access_token, expiresIn: token.expires_in };
}

// A token for one user's own Vertex AI calls: its subject is that user's app ID.
export function userGoogleToken(env: GoogleFederationEnv, fetcher: typeof fetch, now: Date, userId: string): Promise<GoogleToken> {
  if (!USER_SUBJECT.test(userId)) return Promise.reject(new Error("a Google token for a user needs the user's own app ID"));
  return exchange(env, fetcher, now, userId, CLOUD_PLATFORM_SCOPE);
}

// A token for reading the Cloud Billing Catalog, and nothing a user's
// project grants: its subject is the price reader's.
export function priceReaderGoogleToken(env: GoogleFederationEnv, fetcher: typeof fetch, now: Date): Promise<GoogleToken> {
  return exchange(env, fetcher, now, PRICE_READER_SUBJECT, CLOUD_BILLING_READONLY_SCOPE);
}
