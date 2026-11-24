import { beforeAll, describe, expect, it } from "vitest";
import { adminConsentLink, certificateAssertion, deploymentName, ENTRA_FEDERATED_AUDIENCE, ENTRA_SUBJECT, FOUNDRY_SCOPE, foundryPlugin } from "../src/providers/foundry";
import { ProviderRefusal, type Failure } from "../src/proxy/plugin";
import { APP_ORIGIN, decodeJwt, decodePart, issuerKey, issuerKeys, scriptedFetch, type Sent } from "./issuer-fixture";

const NOW = new Date("2026-11-25T10:00:00Z");
const CLIENT_ID = "00000000-0000-4000-8000-000000000001";
const TENANT = "11111111-2222-4333-8444-555555555555";
const ENDPOINT = "https://example-resource.services.ai.azure.com";
const connection = { tenantId: TENANT, endpoint: ENDPOINT };
let keyPem: string;
let publicKey: CryptoKey;
let ISSUER_KEYS: string;

// The PEM armour of the key generated here, built from parts so the secret
// scanner does not take the test's own code for a committed key.
const LABEL = ["PRIVATE", "KEY"].join(" ");
const pem = (der: ArrayBuffer) =>
  `-----BEGIN ${LABEL}-----\n${btoa(String.fromCharCode(...new Uint8Array(der))).replace(/(.{64})/g, "$1\n")}\n-----END ${LABEL}-----\n`;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  keyPem = pem((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  publicKey = pair.publicKey;
  ISSUER_KEYS = issuerKeys("k1", [await issuerKey("k1")]);
});

const envWith = (over: Record<string, string | undefined> = {}) => ({
  APP_ORIGIN, ISSUER_KEYS, ENTRA_CLIENT_ID: CLIENT_ID, ENTRA_CERT_KEY: keyPem, ENTRA_CERT_THUMBPRINT: "thumbprint-b64url", ...over,
});

const form = (s: Sent) => Object.fromEntries(new URLSearchParams(s.body));

const messagesOk = () =>
  Response.json({
    id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "OK" }],
    usage: { input_tokens: 14, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });

function azure(token: (s: Sent) => Response = () => Response.json({ token_type: "Bearer", expires_in: 4500, access_token: "entra-access-token" }), messages: (s: Sent) => Response = messagesOk) {
  return scriptedFetch([
    [/^https:\/\/login\.microsoftonline\.com\//, token],
    [/services\.ai\.azure\.com\/anthropic\/v1\/messages$/, messages],
  ]);
}

describe("Connect Microsoft Foundry", () => {
  it("sends the user to Microsoft's admin consent in their own tenant, never `common`, and keeps the endpoint until it returns", () => {
    const start = foundryPlugin(envWith()).connect.start({ endpoint: `${ENDPOINT}/` }, { userId: "u", appOrigin: APP_ORIGIN, consentState: "state-123" });
    expect(start).toEqual({
      kind: "consent",
      pending: { endpoint: ENDPOINT },
      open: adminConsentLink({ clientId: CLIENT_ID, appOrigin: APP_ORIGIN, state: "state-123" }),
    });
    const link = new URL(start.open!);
    expect(link.origin + link.pathname).toBe("https://login.microsoftonline.com/organizations/adminconsent");
    expect(Object.fromEntries(link.searchParams)).toEqual({ client_id: CLIENT_ID, redirect_uri: `${APP_ORIGIN}/models/setup/providers/foundry/consented`, state: "state-123" });
  });

  it("finishes with the tenant Microsoft returns, and refuses a refused or odd answer", () => {
    const { connect } = foundryPlugin(envWith());
    const back = (q: Record<string, string>) => new URLSearchParams(q);
    expect(connect.finish!({ endpoint: ENDPOINT }, back({ tenant: TENANT.toUpperCase(), admin_consent: "True", state: "s" }))).toEqual(connection);
    expect(() => connect.finish!({ endpoint: ENDPOINT }, back({ error: "access_denied", error_description: "The admin canceled the request" }))).toThrow(/The admin canceled the request/);
    expect(() => connect.finish!({ endpoint: ENDPOINT }, back({ tenant: "contoso.onmicrosoft.com", admin_consent: "True" }))).toThrow(/did not say/);
    expect(() => connect.finish!({ endpoint: ENDPOINT }, back({ tenant: TENANT }))).toThrow(/did not say/);
  });

  it("takes only a Foundry resource address", () => {
    const f = foundryPlugin(envWith()).connect.fields[0]!;
    const ok = (v: string) => new RegExp(`^(?:${f.pattern})$`).test(v);
    expect(ok(ENDPOINT)).toBe(true);
    expect(ok("https://evil.example.com/x.services.ai.azure.com")).toBe(false);
    expect(ok("http://example-resource.services.ai.azure.com")).toBe(false);
  });

  it("cannot start before the app's Entra registration exists (T10)", () => {
    expect(() => foundryPlugin(envWith({ ENTRA_CLIENT_ID: undefined })).connect.start({ endpoint: ENDPOINT }, { userId: "u", appOrigin: APP_ORIGIN, consentState: "s" })).toThrow(/ENTRA_CLIENT_ID/);
  });
});

describe("the Foundry credential", () => {
  it("is a client-credentials token in the user's tenant, proven by a PS256 certificate assertion", async () => {
    const { fetcher, sent } = azure();
    const credential = await foundryPlugin(envWith(), fetcher, () => NOW).mintCredential(connection);
    expect(credential).toMatchObject({ accessToken: "entra-access-token" });
    expect(sent[0]!.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    const f = form(sent[0]!);
    expect(f).toMatchObject({ client_id: CLIENT_ID, scope: FOUNDRY_SCOPE, grant_type: "client_credentials", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" });
    expect(f.client_secret).toBeUndefined();
    const { header, claims } = decodeJwt(f.client_assertion!);
    expect(header).toEqual({ alg: "PS256", typ: "JWT", "x5t#S256": "thumbprint-b64url" });
    const t = NOW.getTime() / 1000;
    expect(claims).toMatchObject({ aud: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, iss: CLIENT_ID, sub: CLIENT_ID, nbf: t, iat: t });
    expect((claims.exp as number) - (claims.nbf as number)).toBeLessThanOrEqual(600);
    // Signed with the certificate's key, PSS padding.
    const [h, p, s] = f.client_assertion!.split(".") as [string, string, string];
    const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
    expect(await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 32 }, publicKey, sig, new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  });

  it("switches to a federated credential on the app's issuer when FOUNDRY_CREDENTIAL says so, with no certificate", async () => {
    const { fetcher, sent } = azure();
    await foundryPlugin(envWith({ FOUNDRY_CREDENTIAL: "federated", ENTRA_CERT_KEY: undefined, ENTRA_CERT_THUMBPRINT: undefined }), fetcher, () => NOW).mintCredential(connection);
    const { claims, header } = decodeJwt(form(sent[0]!).client_assertion!);
    expect(header.alg).toBe("RS256");
    expect(claims).toMatchObject({ iss: `${APP_ORIGIN}/oidc`, aud: ENTRA_FEDERATED_AUDIENCE, sub: ENTRA_SUBJECT });
  });

  it("passes Entra's refusal on with its AADSTS code", async () => {
    const { fetcher } = azure(() =>
      Response.json({ error: "unauthorized_client", error_description: `AADSTS700016: Application with identifier '${CLIENT_ID}' was not found in the directory.\r\nTrace ID: x`, error_codes: [700016] }, { status: 400 }));
    const error = (await foundryPlugin(envWith(), fetcher, () => NOW).mintCredential(connection).catch((e: unknown) => e)) as ProviderRefusal;
    expect(error).toBeInstanceOf(ProviderRefusal);
    expect(error.refusal).toEqual({ step: "token", status: 400, errorName: "AADSTS700016", message: `AADSTS700016: Application with identifier '${CLIENT_ID}' was not found in the directory.` });
  });

  it("is not configured before the certificate exists (T10)", async () => {
    await expect(foundryPlugin(envWith({ ENTRA_CERT_KEY: undefined })).mintCredential(connection)).rejects.toMatchObject({ missing: ["ENTRA_CERT_KEY"] });
  });

  it("makes an assertion verifiable on its own", async () => {
    const token = await certificateAssertion({ clientId: CLIENT_ID, tenantId: TENANT, keyPem, thumbprint: "t", now: NOW });
    expect(decodePart(token.split(".")[1]!).jti).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("the Foundry caller", () => {
  it("calls Claude's Messages endpoint with the bearer token and the deployment name as the model", async () => {
    const { fetcher, sent } = azure();
    const plugin = foundryPlugin(envWith(), fetcher, () => NOW);
    const reply = await plugin.call({ credential: { accessToken: "entra-access-token" }, connection, model: "Claude Haiku 5.5", location: "global", request: plugin.connect.testRequest("Claude Haiku 5.5", "global") });
    expect(sent[0]!.url).toBe(`${ENDPOINT}/anthropic/v1/messages`);
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer entra-access-token");
    expect(sent[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(sent[0]!.headers.get("x-api-key")).toBeNull();
    expect(JSON.parse(sent[0]!.body)).toEqual({ model: "claude-haiku-5-5", max_tokens: 5, messages: [{ role: "user", content: "Reply with the single word OK." }] });
    expect(reply.usage).toEqual({ input: 14, cachedInput: 0, cacheWrite: 0, cacheWrite1h: 0, output: 2, longPrompt: false });
    expect(plugin.connect.replyText(reply.body)).toBe("OK");
    expect(deploymentName("Claude Fable 5.1")).toBe("claude-fable-5-1");
  });

  it("reads 5-minute and 1-hour cache writes apart", async () => {
    const { fetcher } = azure(undefined, () =>
      Response.json({ content: [], usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 248, cache_creation: { ephemeral_5m_input_tokens: 148, ephemeral_1h_input_tokens: 100 } } }));
    const reply = await foundryPlugin(envWith(), fetcher).call({ credential: { accessToken: "t" }, connection, model: "Claude Sonnet 5.5", location: "global", request: {} });
    expect(reply.usage).toEqual({ input: 50, cachedInput: 2000, cacheWrite: 148, cacheWrite1h: 100, output: 10, longPrompt: false });
  });

  it("hands back the provider's error name and message", async () => {
    const { fetcher } = azure(undefined, () => Response.json({ error: { code: "DeploymentNotFound", message: "The API deployment for this resource does not exist." } }, { status: 404 }));
    const reply = await foundryPlugin(envWith(), fetcher).call({ credential: { accessToken: "t" }, connection, model: "Claude Haiku 5.5", location: "global", request: {} });
    expect(reply).toMatchObject({ status: 404, error: { name: "DeploymentNotFound", message: "The API deployment for this resource does not exist." } });
  });
});

describe("Foundry's plain reasons", () => {
  const classify = (f: Partial<Failure>) => foundryPlugin(envWith()).connect.classify({ step: "call", status: 400, errorName: "", message: "", ...f }, connection);
  it.each([
    [{ step: "credential", status: 400, errorName: "AADSTS700016" }, "not_set_up"],
    [{ step: "credential", status: 400, errorName: "AADSTS90094" }, "not_set_up"],
    [{ step: "credential", status: 401, errorName: "AADSTS700027" }, "app_not_configured"],
    [{ status: 401, errorName: "PermissionDenied" }, "not_set_up"],
    [{ status: 403, errorName: "PermissionDenied", message: "The principal does not have the data action required." }, "not_set_up"],
    [{ status: 404, errorName: "DeploymentNotFound" }, "no_such_model"],
    [{ status: 400, errorName: "invalid_request_error", message: "The model requires data retention, but your subscription has zero data retention (ZDR) enabled." }, "data_retention"],
    [{ status: 400, errorName: "InvalidRegion", message: "Region not available for this model" }, "region_unavailable"],
    [{ status: 403, errorName: "Forbidden", message: "Your Azure subscription type or billing region isn't supported" }, "not_allowed_yet"],
    [{ status: 429, errorName: "RateLimitReached" }, "busy"],
    [{ status: 400, errorName: "invalid_request_error", message: "max_tokens: too large" }, "refused"],
  ] as Array<[Partial<Failure>, string]>)("%j is %s", (f, reason) => {
    expect(classify(f).reason).toBe(reason);
  });
});
