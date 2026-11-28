import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { ENV, generateKey, serveCerts, signToken, type TestKey } from "./access-fixture";

let key: TestKey;

beforeAll(async () => {
  key = await generateKey("kid-health");
});

afterEach(() => vi.restoreAllMocks());

// Every request passes the Access check first (see access.test.ts).
const get = async (path: string): Promise<Response> => {
  serveCerts(() => [key]);
  const headers = { "cf-access-jwt-assertion": await signToken(key) };
  return worker.fetch(new Request(`https://shell.test${path}`, { headers }), { ...env, ...ENV });
};

describe("GET /chief-of-staff/health", () => {
  it("returns a JSON OK", async () => {
    const response = await get("/chief-of-staff/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("answers 404 for an unknown path under the prefix", async () => {
    const response = await get("/chief-of-staff/nope");
    expect(response.status).toBe(404);
  });
});
