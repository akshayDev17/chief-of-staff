import { env as testEnv } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { clearAccessKeyCache, readAccessConfig } from "../src/access";
import { AUD, ENV, TEAM_DOMAIN, generateKey, serveCerts, signToken, type TestKey } from "./access-fixture";

let key: TestKey;
let otherKey: TestKey;
let served: TestKey[];

beforeAll(async () => {
  key = await generateKey("kid-current");
  otherKey = await generateKey("kid-other");
});

beforeEach(() => {
  clearAccessKeyCache();
  served = [key];
  serveCerts(() => served);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const send = (headers: Record<string, string> = {}, env: Record<string, string> = ENV) =>
  worker.fetch(new Request("https://shell.test/chief-of-staff/health", { headers }), { ...testEnv, ...env });

// The same request as a WebSocket upgrade.
const upgrade = (headers: Record<string, string> = {}) =>
  send({ upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": btoa("the sample nonce"), ...headers });

const now = () => Math.floor(Date.now() / 1000);

const refusedCases: [string, () => Promise<string>][] = [
  ["expired", () => signToken(key, { exp: now() - 3600 })],
  ["not yet valid", () => signToken(key, { nbf: now() + 3600 })],
  ["wrong audience", () => signToken(key, { aud: ["another-app-aud"] })],
  ["wrong issuer", () => signToken(key, { iss: "https://another-team.cloudflareaccess.com" })],
  ["signed by a key not in the team's set", () => signToken(otherKey, {}, { kid: "kid-current" })],
  ["signed by an unknown key id", () => signToken(otherKey)],
  ["alg none", async () => (await signToken(key, {}, { alg: "none" })).replace(/\.[^.]+$/, ".")],
  ["tampered payload", async () => {
    const [h, , s] = (await signToken(key)).split(".");
    const forged = btoa(JSON.stringify({ iss: TEAM_DOMAIN, aud: [AUD], exp: now() + 3600, email: "x@example.com" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${h}.${forged}.${s}`;
  }],
  ["malformed", async () => "not-a-jwt"],
];

describe.each([
  ["HTTP", send],
  ["WebSocket upgrade", upgrade],
] as const)("Access check on %s", (_name, call) => {
  it("lets a valid token in the header through", async () => {
    const response = await call({ "cf-access-jwt-assertion": await signToken(key) });
    expect(response.status).toBe(200);
  });

  it("refuses a valid token sent only in the CF_Authorization cookie", async () => {
    const response = await call({ cookie: `other=1; CF_Authorization=${await signToken(key)}` });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
  });

  it("refuses a request without a token, with no body detail", async () => {
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
  });

  it.each(refusedCases)("refuses a token that is %s", async (_case, make) => {
    const response = await call({ "cf-access-jwt-assertion": await make() });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
  });
});

describe("Access check configuration and keys", () => {
  it("refuses everything when the team domain or AUD is not set", async () => {
    const token = await signToken(key);
    expect((await send({ "cf-access-jwt-assertion": token }, { ACCESS_AUD: AUD })).status).toBe(403);
    expect((await send({ "cf-access-jwt-assertion": token }, { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN })).status).toBe(403);
    expect((await send({ "cf-access-jwt-assertion": token }, {})).status).toBe(403);
  });

  it("accepts a cloudflareaccess.com team domain, bare or over https, and nothing else", () => {
    expect(readAccessConfig({ ACCESS_TEAM_DOMAIN: `${TEAM_DOMAIN}/`, ACCESS_AUD: AUD })).toEqual({ teamDomain: TEAM_DOMAIN, audience: AUD });
    expect(readAccessConfig({ ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com", ACCESS_AUD: AUD })).toEqual({ teamDomain: TEAM_DOMAIN, audience: AUD });
    expect(readAccessConfig({ ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com/", ACCESS_AUD: AUD })).toEqual({ teamDomain: TEAM_DOMAIN, audience: AUD });
    expect(readAccessConfig({ ACCESS_TEAM_DOMAIN: "evil.example.com", ACCESS_AUD: AUD })).toBeNull();
    expect(readAccessConfig({ ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com/path", ACCESS_AUD: AUD })).toBeNull();
    expect(readAccessConfig({ ACCESS_TEAM_DOMAIN: "http://example-team.cloudflareaccess.com", ACCESS_AUD: AUD })).toBeNull();
    expect(readAccessConfig({ ACCESS_TEAM_DOMAIN: "https://evil.example.com", ACCESS_AUD: AUD })).toBeNull();
  });

  it("caches the keys between requests", async () => {
    const spy = vi.mocked(globalThis.fetch);
    for (let i = 0; i < 3; i++) {
      expect((await send({ "cf-access-jwt-assertion": await signToken(key) })).status).toBe(200);
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refetches the keys when a token names an unknown key id (rotation)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const spy = vi.mocked(globalThis.fetch);
    expect((await send({ "cf-access-jwt-assertion": await signToken(key) })).status).toBe(200);
    const rotated = await generateKey("kid-rotated");
    served = [rotated, key];
    vi.setSystemTime(Date.now() + 31_000);
    expect((await send({ "cf-access-jwt-assertion": await signToken(rotated) })).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not refetch on every unknown key id within the refresh floor", async () => {
    const spy = vi.mocked(globalThis.fetch);
    expect((await send({ "cf-access-jwt-assertion": await signToken(key) })).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      expect((await send({ "cf-access-jwt-assertion": await signToken(otherKey) })).status).toBe(403);
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refuses when the keys cannot be fetched", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("down", { status: 503 }));
    expect((await send({ "cf-access-jwt-assertion": await signToken(key) })).status).toBe(403);
  });
});
