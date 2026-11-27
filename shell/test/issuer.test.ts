import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { DISCOVERY_PATH, ID_TOKEN_LIFETIME_S, JWKS_PATH, mintIdToken, parseIssuerKeys, readIssuer } from "../src/issuer";
// @ts-expect-error: a plain JavaScript module run by Node.
import { rotateIssuerKeys } from "../scripts/issuer-keys-lib.mjs";
import { ENV, generateKey, serveCerts, signToken, type TestKey } from "./access-fixture";
import { APP_ORIGIN, decodeJwt, issuerKey, issuerKeys, verifiesAgainst } from "./issuer-fixture";

let accessKey: TestKey;
let oldKey: JsonWebKey & { kid: string };
let newKey: JsonWebKey & { kid: string };

beforeAll(async () => {
  accessKey = await generateKey("kid-issuer-tests");
  oldKey = await issuerKey("issuer-old");
  newKey = await issuerKey("issuer-new");
});
afterEach(() => vi.restoreAllMocks());

const NOW = new Date("2026-11-25T10:00:00Z");

// No Access token at all: what AWS, Google and Microsoft send.
const anonymous = (path: string, keys: string | undefined, init: RequestInit = {}) =>
  worker.fetch(new Request(`${APP_ORIGIN}${path}`, init), { ...ENV, DB: env.DB, APP_ORIGIN, ISSUER_KEYS: keys });

describe("the issuer's public documents", () => {
  it("serves the discovery document without sign-in, naming the issuer and its key set", async () => {
    const response = await anonymous(DISCOVERY_PATH, issuerKeys("issuer-old", [oldKey]));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({
      issuer: `${APP_ORIGIN}/chief-of-staff/oidc`,
      jwks_uri: `${APP_ORIGIN}/chief-of-staff/oidc/jwks.json`,
      id_token_signing_alg_values_supported: ["RS256"],
    });
  });

  it("publishes only public key members", async () => {
    const response = await anonymous(JWKS_PATH, issuerKeys("issuer-old", [oldKey]));
    const jwks = (await response.json()) as { keys: Array<Record<string, unknown>> };
    expect(jwks.keys).toHaveLength(1);
    expect(Object.keys(jwks.keys[0]!).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
    expect(JSON.stringify(jwks)).not.toContain(oldKey.d!);
  });

  it("answers 404, not a guess, before the issuer is configured", async () => {
    expect((await anonymous(JWKS_PATH, undefined)).status).toBe(404);
  });

  it("exempts exactly those two paths from the Access check, and only for GET", async () => {
    const keys = issuerKeys("issuer-old", [oldKey]);
    for (const path of ["/chief-of-staff/oidc", "/chief-of-staff/oidc/", "/chief-of-staff/oidc/jwks.json/", "/chief-of-staff/oidc/jwks.json.bak", "/chief-of-staff/oidc/.well-known/", "/chief-of-staff/.well-known/openid-configuration", "/chief-of-staff/jwks.json", "/chief-of-staff/health", "/chief-of-staff/models/setup/providers"]) {
      expect((await anonymous(path, keys)).status, path).toBe(403);
    }
    expect((await anonymous(JWKS_PATH, keys, { method: "POST" })).status).toBe(403);
  });

  it("still serves every other path only with a valid Access token", async () => {
    serveCerts(() => [accessKey]);
    const response = await worker.fetch(new Request(`${APP_ORIGIN}/chief-of-staff/health`, { headers: { "cf-access-jwt-assertion": await signToken(accessKey) } }), {
      ...ENV, DB: env.DB, APP_ORIGIN, ISSUER_KEYS: issuerKeys("issuer-old", [oldKey]),
    });
    expect(response.status).toBe(200);
  });
});

describe("the issuer's tokens", () => {
  it("are RS256, short-lived, with the provider's audience and subject, and verify against the published keys", async () => {
    const keys = issuerKeys("issuer-old", [oldKey]);
    const token = await mintIdToken(await readIssuer({ APP_ORIGIN, ISSUER_KEYS: keys }), { audience: "https://relying-party.example", subject: "chief-of-staff:test", now: NOW });
    const { header, claims } = decodeJwt(token);
    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: "issuer-old" });
    const iat = NOW.getTime() / 1000;
    expect(claims).toMatchObject({ iss: `${APP_ORIGIN}/chief-of-staff/oidc`, aud: "https://relying-party.example", sub: "chief-of-staff:test", iat, nbf: iat, exp: iat + ID_TOKEN_LIFETIME_S });
    expect(ID_TOKEN_LIFETIME_S).toBeLessThanOrEqual(300);
    const published = await (await anonymous(JWKS_PATH, keys)).json();
    expect(await verifiesAgainst(token, published as never)).toBe(true);
    // Tampered claims do not verify.
    const [h, , s] = token.split(".");
    const forged = `${h}.${btoa(JSON.stringify({ ...claims, sub: "someone-else" })).replace(/=+$/, "")}.${s}`;
    expect(await verifiesAgainst(forged, published as never)).toBe(false);
  });

  it("keep verifying through a rotation: old and new keys are published together until the old is retired", async () => {
    const start = { signing: "issuer-old", keys: [oldKey] };
    const envFor = (k: { signing: string; keys: JsonWebKey[] }) => ({ APP_ORIGIN, ISSUER_KEYS: JSON.stringify(k) });
    const jwksFor = async (k: { signing: string; keys: JsonWebKey[] }) => (await anonymous(JWKS_PATH, JSON.stringify(k))).json() as never;
    const oldToken = await mintIdToken(await readIssuer(envFor(start)), { audience: "a", subject: "s", now: NOW });

    const published = rotateIssuerKeys(start, "publish", newKey);
    expect(published.signing).toBe("issuer-old");
    expect(await verifiesAgainst(oldToken, await jwksFor(published))).toBe(true);

    const signing = rotateIssuerKeys(published, "sign");
    const newToken = await mintIdToken(await readIssuer(envFor(signing)), { audience: "a", subject: "s", now: NOW });
    expect(decodeJwt(newToken).header.kid).toBe("issuer-new");
    // Both kinds of token verify while both keys are published: no connection breaks.
    expect(await verifiesAgainst(oldToken, await jwksFor(signing))).toBe(true);
    expect(await verifiesAgainst(newToken, await jwksFor(signing))).toBe(true);

    const retired = rotateIssuerKeys(signing, "retire");
    expect(retired.keys.map((k: { kid: string }) => k.kid)).toEqual(["issuer-new"]);
    expect(await verifiesAgainst(newToken, await jwksFor(retired))).toBe(true);
    expect(await verifiesAgainst(oldToken, await jwksFor(retired))).toBe(false);
  });

  it("refuses rotation steps out of order", () => {
    const start = { signing: "issuer-old", keys: [oldKey] };
    expect(() => rotateIssuerKeys(start, "sign")).toThrow(/publish the new one first/);
    expect(() => rotateIssuerKeys(start, "retire")).toThrow(/nothing to retire/);
    expect(() => rotateIssuerKeys(rotateIssuerKeys(start, "publish", newKey), "publish", newKey)).toThrow(/already under way/);
  });

  it("refuses a key set without a private signing key, or with a key that is not RSA", () => {
    const { d: _d, ...publicOnly } = oldKey;
    expect(() => parseIssuerKeys(issuerKeys("issuer-old", [publicOnly]))).toThrow(/private half/);
    expect(() => parseIssuerKeys(issuerKeys("missing", [oldKey]))).toThrow(/must be one of its keys/);
    expect(() => parseIssuerKeys(issuerKeys("x", [{ kty: "EC", kid: "x" } as JsonWebKey]))).toThrow(/RSA JWK/);
    expect(() => parseIssuerKeys("[]")).toThrow(/signing/);
  });

  it("is not configured without APP_ORIGIN and ISSUER_KEYS", async () => {
    await expect(readIssuer({})).rejects.toMatchObject({ name: "AppNotConfigured", missing: ["APP_ORIGIN", "ISSUER_KEYS"] });
    await expect(readIssuer({ APP_ORIGIN: "http://cos.example.com", ISSUER_KEYS: "{}" })).rejects.toMatchObject({ missing: ["APP_ORIGIN"] });
  });
});
