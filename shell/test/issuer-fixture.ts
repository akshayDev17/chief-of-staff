// Test-only issuer keys and a scripted fetch for the provider plug-ins. Every
// key is generated here, per run; no real key, account or tenant appears.

export const APP_ORIGIN = "https://cos.example.com";

const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as const;

// A private RSA JWK with a kid, as provider-setup.mjs makes them.
export async function issuerKey(kid: string): Promise<JsonWebKey & { kid: string }> {
  const pair = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { ...jwk, kid, alg: "RS256" };
}

export const issuerKeys = (signing: string, keys: JsonWebKey[]): string => JSON.stringify({ signing, keys });

export const decodePart = (part: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4)), (c) => c.charCodeAt(0))));

export const decodeJwt = (token: string) => {
  const [h, p] = token.split(".");
  return { header: decodePart(h!), claims: decodePart(p!) };
};

// Verifies an RS256 token against a published key set.
export async function verifiesAgainst(token: string, jwks: { keys: Array<JsonWebKey & { kid?: string }> }): Promise<boolean> {
  const [h, p, s] = token.split(".") as [string, string, string];
  const { kid } = decodePart(h) as { kid: string };
  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, RSA, false, ["verify"]);
  const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
  return crypto.subtle.verify(RSA.name, key, sig, new TextEncoder().encode(`${h}.${p}`));
}

export interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

// A fetch that answers from a list of [matcher, reply] routes and keeps every request.
export function scriptedFetch(routes: Array<[RegExp, (sent: Sent) => Response | Promise<Response>]>) {
  const sent: Sent[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const s: Sent = { url: request.url, method: request.method, headers: request.headers, body: new TextDecoder().decode(await request.arrayBuffer()) };
    sent.push(s);
    const route = routes.find(([pattern]) => pattern.test(s.url));
    if (!route) throw new Error(`no route for ${s.url}`);
    return route[1](s);
  }) as typeof fetch;
  return { fetcher, sent };
}

export const xml = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/xml" } });

export const stsCredentials = (action: string, id: string) =>
  xml(`<${action}Response xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><${action}Result><Credentials>
<AccessKeyId>${id}</AccessKeyId><SecretAccessKey>secret-${id}</SecretAccessKey><SessionToken>token-${id}</SessionToken>
<Expiration>2026-11-25T11:00:00Z</Expiration></Credentials></${action}Result></${action}Response>`);

export const stsError = (code: string, message: string, status = 403) =>
  xml(`<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error><RequestId>r-1</RequestId></ErrorResponse>`, status);
