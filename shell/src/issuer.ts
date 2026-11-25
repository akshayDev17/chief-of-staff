// The app's own OpenID Connect issuer (design-v3 1.4, T16). AWS, Google and
// (if M2 shows it works across tenants) Microsoft trust it, so the app holds
// no long-lived cloud key: the provider plug-ins mint a short ID token here and
// trade it for that provider's own short-lived credential.
//
//   issuer URL:   <APP_ORIGIN>/chief-of-staff/oidc
//   discovery:    <APP_ORIGIN>/chief-of-staff/oidc/.well-known/openid-configuration
//   key set:      <APP_ORIGIN>/chief-of-staff/oidc/jwks.json
//
// Those two documents are the only paths served without the owner's sign-in:
// the providers fetch them (index.ts exempts exactly these two from the
// Access check; the portfolio-app tool's Bypass Access application covers
// exactly these two, README "Cloudflare Access").
//
// One app-wide signing key, RS256 (the one algorithm all three accept:
// Microsoft's federated credentials "Only issuers that provide tokens signed
// using the RS256 algorithm are supported", AWS takes "RSA keys (RS256, RS384,
// or RS512)", Google "RS256 or ES256"; data/cos-provider-connect/report.md,
// read 2026-11-24). It sits in the Worker secret ISSUER_KEYS:
//
//   {"signing": "<kid>", "keys": [<JWK>, ...]}
//
// Every key in `keys` is published; only `signing` signs, and it must be a
// private key. Rotating is one place, this secret, in three steps that keep
// old and new public keys published together (README "Rotating the issuer
// key"; scripts/provider-setup.mjs rotate-issuer does each step):
//   1. publish: add the new key, still signing with the old one;
//   2. sign: once every provider has fetched the new key set, sign with the new key;
//   3. retire: once every token signed with the old key has expired, drop it.
// Tokens live 5 minutes; nothing here is cached beyond one request.

import { BASE_PATH } from "./paths";

export const ISSUER_PATH = `${BASE_PATH}/oidc`;
export const DISCOVERY_PATH = `${ISSUER_PATH}/.well-known/openid-configuration`;
export const JWKS_PATH = `${ISSUER_PATH}/jwks.json`;
// Served without the owner's sign-in, and nothing else is.
export const PUBLIC_ISSUER_PATHS: readonly string[] = [DISCOVERY_PATH, JWKS_PATH];

// Long enough to make the one exchange it is minted for, short enough that
// a leaked token is useless almost at once. Google: `exp` at most 24 hours
// after `iat`, and "we recommend setting an expiration time less than 6 hours"
// (STS token reference, read 2026-11-25).
export const ID_TOKEN_LIFETIME_S = 300;

export interface IssuerKeys {
  signing: string;
  keys: JsonWebKey[];
}

export interface Issuer {
  url: string;
  kid: string;
  signingKey: CryptoKey;
  keys: JsonWebKey[];
}

// The app's own side of a provider (this issuer, an AWS role ARN, the Entra
// certificate...) is not configured yet: the owner's one-time T10 steps.
export class AppNotConfigured extends Error {
  constructor(readonly missing: string[]) {
    super(`not configured yet: ${missing.join(", ")}`);
    this.name = "AppNotConfigured";
  }
}

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

// The app's own address, `https://<host>` with no path: where the issuer and
// the redirect targets live. Undefined when not set or not https.
export function readAppOrigin(env: { APP_ORIGIN?: string }): string | undefined {
  const origin = env.APP_ORIGIN?.trim().replace(/\/+$/, "");
  if (!origin || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin)) return undefined;
  return origin;
}

export const issuerUrl = (appOrigin: string): string => `${appOrigin}${ISSUER_PATH}`;

// Refuses anything that is not a set of RSA keys with ids, one of them the
// private signing key.
export function parseIssuerKeys(text: string): IssuerKeys {
  const parsed = JSON.parse(text) as Partial<IssuerKeys>;
  if (typeof parsed?.signing !== "string" || !Array.isArray(parsed.keys) || parsed.keys.length === 0) {
    throw new Error('ISSUER_KEYS must be {"signing": "<kid>", "keys": [<JWK>, ...]}');
  }
  const kids = new Set<string>();
  for (const key of parsed.keys) {
    const kid = (key as { kid?: unknown }).kid;
    if (key?.kty !== "RSA" || typeof kid !== "string" || !kid || !key.n || !key.e) {
      throw new Error("every ISSUER_KEYS key must be an RSA JWK with a kid, n and e");
    }
    if (kids.has(kid)) throw new Error(`ISSUER_KEYS has two keys with kid ${kid}`);
    kids.add(kid);
  }
  const signing = parsed.keys.find((k) => (k as { kid?: string }).kid === parsed.signing);
  if (!signing?.d) throw new Error(`ISSUER_KEYS' signing key ${parsed.signing} must be one of its keys, with its private half`);
  return { signing: parsed.signing, keys: parsed.keys };
}

export async function readIssuer(env: { APP_ORIGIN?: string; ISSUER_KEYS?: string }): Promise<Issuer> {
  const origin = readAppOrigin(env);
  const missing = [...(origin ? [] : ["APP_ORIGIN"]), ...(env.ISSUER_KEYS ? [] : ["ISSUER_KEYS"])];
  if (missing.length) throw new AppNotConfigured(missing);
  const { signing, keys } = parseIssuerKeys(env.ISSUER_KEYS!);
  const jwk = keys.find((k) => (k as { kid?: string }).kid === signing)!;
  const signingKey = await crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256", ext: false, key_ops: ["sign"] }, RS256, false, ["sign"]);
  return { url: issuerUrl(origin!), kid: signing, signingKey, keys };
}

// The discovery document: AWS needs "issuer" and "jwks_uri" in it; Google
// fetches the key set through it.
export const discoveryDocument = (url: string) => ({
  issuer: url,
  jwks_uri: `${url}/jwks.json`,
  response_types_supported: ["id_token"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
  claims_supported: ["iss", "sub", "aud", "exp", "iat", "nbf", "jti"],
});

// The public halves of every key, never a private field.
export const publicKeySet = (keys: JsonWebKey[]) => ({
  keys: keys.map((k) => ({ kty: "RSA", kid: (k as { kid?: string }).kid, use: "sig", alg: "RS256", n: k.n, e: k.e })),
});

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const base64urlText = (text: string): string => base64url(new TextEncoder().encode(text));

// Signs a JWT with the given key: header and claims as given.
export async function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: CryptoKey,
  algorithm: string | { name: string; saltLength?: number } = RS256,
): Promise<string> {
  const input = `${base64urlText(JSON.stringify(header))}.${base64urlText(JSON.stringify(claims))}`;
  const signature = new Uint8Array(await crypto.subtle.sign(algorithm, key, new TextEncoder().encode(input)));
  return `${input}.${base64url(signature)}`;
}

// A short ID token for one provider's token exchange, with the audience and
// subject that provider was told to trust (scripts/provider-setup.mjs prints them).
export async function mintIdToken(issuer: Issuer, claims: { audience: string; subject: string; now: Date }): Promise<string> {
  const iat = Math.floor(claims.now.getTime() / 1000);
  return signJwt(
    { alg: "RS256", typ: "JWT", kid: issuer.kid },
    { iss: issuer.url, sub: claims.subject, aud: claims.audience, iat, nbf: iat, exp: iat + ID_TOKEN_LIFETIME_S, jti: crypto.randomUUID() },
    issuer.signingKey,
  );
}

// GET on one of the two public paths. Undefined for any other path.
export async function handleIssuerRequest(pathname: string, env: { APP_ORIGIN?: string; ISSUER_KEYS?: string }): Promise<Response | undefined> {
  if (!PUBLIC_ISSUER_PATHS.includes(pathname)) return undefined;
  const origin = readAppOrigin(env);
  let keys: IssuerKeys;
  try {
    if (!origin || !env.ISSUER_KEYS) throw new Error("not configured");
    keys = parseIssuerKeys(env.ISSUER_KEYS);
  } catch {
    return new Response(JSON.stringify({ error: "the issuer is not configured yet" }), { status: 404, headers: { "content-type": "application/json" } });
  }
  const body = pathname === DISCOVERY_PATH ? discoveryDocument(issuerUrl(origin)) : publicKeySet(keys.keys);
  // Short cache: a rotation's new key is seen within minutes.
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } });
}
