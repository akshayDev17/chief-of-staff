import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain JavaScript module run by Node at deploy time.
import { APP_NAME, ISSUER_APP_NAME, ISSUER_PATHS, ISSUER_POLICY_NAME, POLICY_NAME, cloudflareApi, readInputs, syncAccessApp } from "../scripts/access-app.mjs";
import { PUBLIC_ISSUER_PATHS } from "../src/issuer";

const EMAIL = "morgan.sample@example.com";
const INPUTS = { accountId: "acct", domain: "cos.example.com", ownerEmail: EMAIL };

type Call = { method: string; path: string; body?: any };

const fakeApi = (state: { policies: any[]; apps: any[] }) => {
  const calls: Call[] = [];
  const request = async (method: string, path: string, body?: any) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.includes("/policies")) return state.policies;
    if (method === "GET" && path.includes("/apps")) return state.apps;
    const last = path.split("/").pop();
    if (path.includes("/policies")) return { id: last === "policies" ? `pol-new-${body.decision}` : last, ...body };
    return { id: last === "apps" ? `app-new-${body.policies[0].id}` : last, aud: "aud-tag", ...body };
  };
  return { calls, request };
};

describe("syncAccessApp", () => {
  it("creates the policy and the application when neither exists", async () => {
    const { calls, request } = fakeApi({ policies: [], apps: [] });
    const result = await syncAccessApp(request, INPUTS);
    expect(result).toEqual({
      appId: "app-new-pol-new-allow", aud: "aud-tag", policyId: "pol-new-allow", issuerAppId: "app-new-pol-new-bypass",
      created: { app: true, policy: true, issuerApp: true, issuerPolicy: true },
    });
    const [policy, issuerPolicy] = calls.filter((c) => c.method === "POST" && c.path === "/accounts/acct/access/policies");
    expect(policy!.body).toMatchObject({ name: POLICY_NAME, decision: "allow", include: [{ email: { email: EMAIL } }] });
    const [app] = calls.filter((c) => c.method === "POST" && c.path === "/accounts/acct/access/apps");
    expect(app!.body).toMatchObject({
      name: APP_NAME,
      type: "self_hosted",
      domain: "cos.example.com",
      destinations: [{ type: "public", uri: "cos.example.com" }],
      policies: [{ id: "pol-new-allow", precedence: 1 }],
    });
    expect(issuerPolicy!.body).toEqual({ name: ISSUER_POLICY_NAME, decision: "bypass", include: [{ everyone: {} }], exclude: [], require: [] });
  });

  it("bypasses Access for exactly the issuer's two documents, the same paths the Worker exempts", async () => {
    expect(ISSUER_PATHS).toEqual(PUBLIC_ISSUER_PATHS);
    const { calls, request } = fakeApi({ policies: [], apps: [] });
    await syncAccessApp(request, INPUTS);
    const issuerApp = calls.find((c) => c.method === "POST" && c.body?.name === ISSUER_APP_NAME)!;
    expect(issuerApp.body.destinations).toEqual([
      { type: "public", uri: "cos.example.com/oidc/.well-known/openid-configuration" },
      { type: "public", uri: "cos.example.com/oidc/jwks.json" },
    ]);
    expect(issuerApp.body.policies).toEqual([{ id: "pol-new-bypass", precedence: 1 }]);
    // The owner-only application still covers the whole address.
    const app = calls.find((c) => c.method === "POST" && c.body?.name === APP_NAME)!;
    expect(app.body.destinations).toEqual([{ type: "public", uri: "cos.example.com" }]);
    // No email reaches the issuer's policy.
    expect(JSON.stringify(calls.filter((c) => c.body?.name?.includes("issuer")))).not.toContain(EMAIL);
  });

  it("updates both in place when they exist, with exactly one allow rule", async () => {
    const { calls, request } = fakeApi({
      policies: [{ id: "pol-1", name: POLICY_NAME }, { id: "pol-2", name: ISSUER_POLICY_NAME }, { id: "x", name: "other" }],
      apps: [{ id: "app-1", name: APP_NAME }, { id: "app-2", name: ISSUER_APP_NAME }],
    });
    const result = await syncAccessApp(request, INPUTS);
    expect(result.created).toEqual({ app: false, policy: false, issuerApp: false, issuerPolicy: false });
    expect(calls.map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual([
      "GET /accounts/acct/access/policies",
      "PUT /accounts/acct/access/policies/pol-1",
      "PUT /accounts/acct/access/policies/pol-2",
      "GET /accounts/acct/access/apps",
      "PUT /accounts/acct/access/apps/app-1",
      "PUT /accounts/acct/access/apps/app-2",
    ]);
    expect(calls[1]!.body.include).toEqual([{ email: { email: EMAIL } }]);
    expect(calls[4]!.body.policies).toEqual([{ id: "pol-1", precedence: 1 }]);
    expect(calls[5]!.body.policies).toEqual([{ id: "pol-2", precedence: 1 }]);
  });

  it("stops when two applications share the name", async () => {
    const { request } = fakeApi({ policies: [], apps: [{ id: "a", name: APP_NAME }, { id: "b", name: APP_NAME }] });
    await expect(syncAccessApp(request, INPUTS)).rejects.toThrow(/more than one/);
  });
});

describe("readInputs", () => {
  const env = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", ACCESS_APP_DOMAIN: "cos.example.com", OWNER_EMAIL: EMAIL };

  it("names every missing input", () => {
    expect(() => readInputs({})).toThrow("missing: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ACCESS_APP_DOMAIN, OWNER_EMAIL");
  });

  it("refuses a bad email without echoing it", () => {
    let message = "";
    try { readInputs({ ...env, OWNER_EMAIL: "not-an-address" }); } catch (e) { message = String(e); }
    expect(message).toMatch(/OWNER_EMAIL is not an email address/);
    expect(message).not.toContain("not-an-address");
  });

  it("refuses a domain with a scheme", () => {
    expect(() => readInputs({ ...env, ACCESS_APP_DOMAIN: "https://cos.example.com" })).toThrow(/without a scheme/);
  });

  it("refuses a domain with a path, so the application covers the whole address", () => {
    expect(() => readInputs({ ...env, ACCESS_APP_DOMAIN: "cos.example.com/app" })).toThrow(/host name only/);
    expect(readInputs(env).domain).toBe("cos.example.com");
  });
});

describe("cloudflareApi", () => {
  it("sends the bearer token and returns the result", async () => {
    let seen: Request | undefined;
    const api = cloudflareApi("tok", async (url: string, init: RequestInit) => {
      seen = new Request(url, init);
      return Response.json({ success: true, result: { id: "x" } });
    });
    expect(await api("POST", "/accounts/a/access/policies", { a: 1 })).toEqual({ id: "x" });
    expect(seen!.url).toBe("https://api.cloudflare.com/client/v4/accounts/a/access/policies");
    expect(seen!.headers.get("authorization")).toBe("Bearer tok");
  });

  it("throws on an API error", async () => {
    const api = cloudflareApi("tok", async () =>
      Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 }));
    await expect(api("GET", "/x")).rejects.toThrow(/403.*10000: Authentication error/);
  });
});
