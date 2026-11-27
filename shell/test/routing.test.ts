// The Worker's route is `akshayprabhakant.com/chief-of-staff*` (wrangler.jsonc):
// it serves everything under `/chief-of-staff` and hands every other path the
// route matches (siblings such as `/chief-of-staff.html`) to the origin
// untouched.
import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { clearAccessKeyCache } from "../src/access";
import { ENV, generateKey, serveCerts, signToken, type TestKey } from "./access-fixture";
const APP_ORIGIN = "https://cos.example.com";

let accessKey: TestKey;

beforeAll(async () => {
  accessKey = await generateKey("kid-routing");
});
beforeEach(() => clearAccessKeyCache());
afterEach(() => vi.restoreAllMocks());

const send = (request: Request) => worker.fetch(request, { ...ENV, DB: env.DB, APP_ORIGIN });

const signedIn = async (path: string, init: RequestInit = {}) => {
  serveCerts(() => [accessKey]);
  return send(new Request(`${APP_ORIGIN}${path}`, { ...init, headers: { "cf-access-jwt-assertion": await signToken(accessKey) } }));
};

// Stands in for the origin: records each request the Worker passes on.
const origin = () => {
  const passed: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    passed.push(input as Request);
    return new Response("from the origin", { status: 404, headers: { "x-origin": "yes" } });
  });
  return passed;
};

describe("under /chief-of-staff", () => {
  it("answers /chief-of-staff and /chief-of-staff/ as the app's home, opening the first setup screen", async () => {
    for (const path of ["/chief-of-staff", "/chief-of-staff/"]) {
      const response = await signedIn(path);
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe(`${APP_ORIGIN}/chief-of-staff/models/setup/providers`);
    }
  });

  it("refuses the home and an API path without a valid Access token", async () => {
    for (const path of ["/chief-of-staff", "/chief-of-staff/health"]) {
      expect((await send(new Request(`${APP_ORIGIN}${path}`))).status, path).toBe(403);
    }
  });

  it("serves an API path to the signed-in owner", async () => {
    const response = await signedIn("/chief-of-staff/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("refuses the removed issuer's two former documents without a token, as any path", async () => {
    for (const path of ["/chief-of-staff/oidc/.well-known/openid-configuration", "/chief-of-staff/oidc/jwks.json"]) {
      expect((await send(new Request(`${APP_ORIGIN}${path}`))).status, path).toBe(403);
    }
  });

  it("leads the old Add a model page to the providers' Connect screens, and nothing else under it", async () => {
    for (const [path, to] of [
      ["/chief-of-staff/models/setup/add", "/chief-of-staff/models/setup/providers"],
      ["/chief-of-staff/models/setup/add?provider=openrouter", "/chief-of-staff/models/setup/providers?provider=openrouter"],
    ]) {
      const response = await signedIn(path!);
      expect(response.status, path).toBe(303);
      expect(new URL(response.headers.get("location")!).pathname + new URL(response.headers.get("location")!).search, path).toBe(to);
    }
    const form = { method: "POST", body: new URLSearchParams({ model: "openai/gpt-6-luna" }), headers: { "content-type": "application/x-www-form-urlencoded", origin: APP_ORIGIN } };
    expect((await signedIn("/chief-of-staff/models/setup/add/openrouter/pick")).status).toBe(404);
    expect((await signedIn("/chief-of-staff/models/setup/add/openrouter/choose", form)).status).toBe(404);
    expect((await signedIn("/chief-of-staff/models/setup/add", form)).status).toBe(404);
  });

  it("links every screen under the prefix", async () => {
    for (const screen of ["providers", "budgets", "tasks"]) {
      const response = await signedIn(`/chief-of-staff/models/setup/${screen}`);
      expect(response.status, screen).toBe(200);
      const paths = [...(await response.text()).matchAll(/(?:href|action)="(\/[^"]*)"/g)].map((m) => m[1]!);
      expect(paths.length, screen).toBeGreaterThan(2);
      for (const path of paths) expect(path, `${screen}: ${path}`).toMatch(/^\/chief-of-staff\//);
    }
  });
});

describe("outside /chief-of-staff", () => {
  it("passes sibling paths the route matches, and any other path, to the origin untouched", async () => {
    for (const path of ["/chief-of-staff.html", "/chief-of-staffx", "/chief-of-staff-x/y", "/", "/quiz/", "/oidc/jwks.json", "/health"]) {
      const passed = origin();
      const request = new Request(`${APP_ORIGIN}${path}?q=1`, { method: "POST", body: "kept", headers: { "x-sample": "kept" } });
      const response = await send(request);
      expect(passed, path).toEqual([request]);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("x-origin"), path).toBe("yes");
      expect(await response.text(), path).toBe("from the origin");
      vi.restoreAllMocks();
    }
  });

  it("never checks an Access token for them, signed in or not", async () => {
    const passed = origin();
    const response = await send(new Request(`${APP_ORIGIN}/chief-of-staff.html`, { headers: { "cf-access-jwt-assertion": "not-a-token" } }));
    expect(response.headers.get("x-origin")).toBe("yes");
    expect(passed).toHaveLength(1);
  });
});
