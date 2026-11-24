// Test-only Access keys and tokens: every key is generated here, per run.
// No real team, application or key appears in the tests.
import { vi } from "vitest";

export const TEAM_DOMAIN = "https://example-team.cloudflareaccess.com";
export const AUD = "test-aud-tag-0000";
export const ENV = { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD };

const RSA = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

export const generateKey = async (kid: string): Promise<TestKey> => {
  const pair = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { kty: "RSA", n: exported.n, e: exported.e, alg: "RS256", use: "sig", kid },
  };
};

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const encodeJson = (value: unknown): string => base64Url(new TextEncoder().encode(JSON.stringify(value)));

export const signToken = async (
  key: TestKey,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const body = encodeJson({ alg: "RS256", kid: key.kid, typ: "JWT", ...header }) + "." +
    encodeJson({
      iss: TEAM_DOMAIN,
      aud: [AUD],
      email: "morgan.sample@example.com",
      sub: "test-sub",
      iat: now,
      nbf: now,
      exp: now + 3600,
      ...claims,
    });
  const signature = await crypto.subtle.sign(RSA.name, key.privateKey, new TextEncoder().encode(body));
  return `${body}.${base64Url(new Uint8Array(signature))}`;
};

// Serves the given keys at the team's certs address; returns the spy so a
// test can count fetches.
export const serveCerts = (keys: () => TestKey[]) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
      return Response.json({ keys: keys().map((k) => k.jwk) });
    }
    return new Response("unexpected fetch", { status: 599 });
  });
