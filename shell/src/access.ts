// The Cloudflare Access check: every request, HTTP and WebSocket upgrade
// alike, must carry a valid Access token, until the site's own sign-in
// exists and T47 checks that instead (design-v3 section 10.3).
//
// Follows Cloudflare's "Validate JWTs" page for Access, read 2026-11-24
// (page metadata dateModified 2026-11-17):
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
// - The token is read only from the `Cf-Access-Jwt-Assertion` header; the
//   page recommends it over the `CF_Authorization` cookie, "since the cookie
//   is not guaranteed to be passed".
// - Keys come from `<team domain>/cdn-cgi/access/certs` (RS256), matched by
//   the token's `kid` in `keys`, never hard-coded: Access rotates its key
//   every 6 weeks and keeps the previous one valid for 7 days, so an
//   unknown `kid` refreshes the cached set.
// - `iss` must equal the team domain, `aud` must contain the application's
//   AUD tag, `exp` must be in the future and `nbf` not in the future.

export interface AccessConfig {
  // `https://<team>.cloudflareaccess.com`, as the page writes it.
  teamDomain: string;
  // The Access application's AUD tag.
  audience: string;
}

export interface AccessClaims {
  email?: string;
  sub?: string;
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  [claim: string]: unknown;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

type KeySet = Map<string, CryptoKey>;

// An unknown `kid` refetches the keys at most this often, so a stream of
// forged tokens cannot turn every request into a fetch to Cloudflare.
const REFRESH_FLOOR_MS = 30_000;
// Tolerance for clock skew between Access and this Worker on exp and nbf.
const CLOCK_SKEW_S = 60;

const cache = new Map<string, { keys: KeySet; fetchedAt: number }>();

export const readAccessConfig = (env: {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}): AccessConfig | null => {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim().replace(/\/+$/, "");
  const audience = env.ACCESS_AUD?.trim();
  if (!teamDomain || !audience) return null;
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) return null;
  return { teamDomain, audience };
};

export const readAccessToken = (request: Request): string | null => {
  const header = request.headers.get("cf-access-jwt-assertion")?.trim();
  return header || null;
};

const decodeBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("bad base64url");
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

const decodeJson = (text: string): unknown =>
  JSON.parse(new TextDecoder().decode(decodeBase64Url(text)));

const importKeys = async (jwks: unknown): Promise<KeySet> => {
  const keys: KeySet = new Map();
  const list = (jwks as { keys?: unknown })?.keys;
  if (!Array.isArray(list)) return keys;
  for (const jwk of list as Jwk[]) {
    if (jwk?.kty !== "RSA" || !jwk.kid) continue;
    if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(jwk.kid, key);
    } catch {
      // A key that does not import cannot verify anything; skip it.
    }
  }
  return keys;
};

const fetchKeys = async (teamDomain: string, now: number): Promise<KeySet> => {
  const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`certs fetch failed: ${response.status}`);
  const keys = await importKeys(await response.json());
  cache.set(teamDomain, { keys, fetchedAt: now });
  return keys;
};

const findKey = async (
  teamDomain: string,
  kid: string,
  now: number,
): Promise<CryptoKey | undefined> => {
  const cached = cache.get(teamDomain);
  const hit = cached?.keys.get(kid);
  if (hit) return hit;
  if (cached && now - cached.fetchedAt < REFRESH_FLOOR_MS) return undefined;
  return (await fetchKeys(teamDomain, now)).get(kid);
};

// Returns the token's claims when it is valid for this application, and
// null for anything else: missing, malformed, badly signed, wrong issuer or
// audience, expired or not yet valid. A failed key fetch is also null.
export const verifyAccessToken = async (
  token: string,
  config: AccessConfig,
  now: number = Date.now(),
): Promise<AccessClaims | null> => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = decodeJson(headerPart) as { alg?: unknown; kid?: unknown };
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

    const key = await findKey(config.teamDomain, header.kid, now);
    if (!key) return null;
    const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(signaturePart),
      signed,
    );
    if (!valid) return null;

    // Cloudflare: "A valid signature alone does not establish that the
    // token is valid for your application."
    const claims = decodeJson(payloadPart) as AccessClaims;
    if (typeof claims !== "object" || claims === null) return null;
    if (claims.iss !== config.teamDomain) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(config.audience)) return null;
    const nowS = Math.floor(now / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= nowS - CLOCK_SKEW_S) return null;
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > nowS + CLOCK_SKEW_S)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
};

// The refusal: 403 with no body detail, the same for every reason.
export const accessDenied = (): Response => new Response(null, { status: 403 });

// The request's verified Access claims, or null when it must be refused.
export const readAccessIdentity = async (
  request: Request,
  env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string },
): Promise<AccessClaims | null> => {
  const config = readAccessConfig(env);
  // Not configured is refused, never let through.
  if (!config) return null;
  const token = readAccessToken(request);
  if (!token) return null;
  return verifyAccessToken(token, config);
};

// Tests only: forget the cached keys.
export const clearAccessKeyCache = (): void => cache.clear();
