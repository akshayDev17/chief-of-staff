import { beforeAll, describe, expect, it } from "vitest";
import { adminConsentLink, certificateAssertion, CONSENT_RETURN_PATH, deploymentName, ENTRA_FEDERATED_AUDIENCE, ENTRA_SUBJECT, FOUNDRY_SCOPE, foundryPlugin, SIGN_IN_RETURN_PATH, signInLink } from "../src/providers/foundry";
import { ConnectProblem, ProviderRefusal, type Failure } from "../src/proxy/plugin";
import { APP_ORIGIN, decodeJwt, decodePart, fakeMicrosoft, issuerKey, issuerKeys, scriptedFetch, type Sent } from "./issuer-fixture";

const NOW = new Date("2026-11-25T10:00:00Z");
const CLIENT_ID = "00000000-0000-4000-8000-000000000001";
const TENANT = "11111111-2222-4333-8444-555555555555";
const ENDPOINT = "https://example-resource.services.ai.azure.com";
const connection = { tenantId: TENANT, endpoint: ENDPOINT };
let keyPem: string;
let publicKey: CryptoKey;
let ISSUER_KEYS: string;
let ms: Awaited<ReturnType<typeof fakeMicrosoft>>;

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
  ms = await fakeMicrosoft();
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

const CONSENT = "consent-state-2";
const context = { appOrigin: APP_ORIGIN, consentState: CONSENT };
const t0 = NOW.getTime() / 1000;
const MSA_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
// A personal Microsoft account signed in to its own Azure directory: `tid`
// is that directory, `idp` the Microsoft account provider.
const goodClaims = (nonce: string, over: Record<string, unknown> = {}) => ({
  iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENT_ID, tid: TENANT, idp: `https://sts.windows.net/${MSA_TENANT}/`, sub: "user-pairwise-sub", nonce,
  iat: t0 - 10, nbf: t0 - 10, exp: t0 + 3600, ver: "2.0", ...over,
});
const signInPending = (nonce: string) => ({ endpoint: ENDPOINT, signInTenant: TENANT, nonce });

// Microsoft as the sign-in has it: the token endpoint redeems the code for
// `idToken`, and the tenant's key set is published.
function microsoft(idToken: string | (() => Response)) {
  return scriptedFetch([
    [new RegExp(`^https://login\\.microsoftonline\\.com/${TENANT}/oauth2/v2\\.0/token$`), () =>
      typeof idToken === "string" ? Response.json({ token_type: "Bearer", scope: "openid", expires_in: 3599, id_token: idToken, access_token: "graph-token-unused" }) : idToken()],
    [/^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]+\/discovery\/v2\.0\/keys$/, () => Response.json(ms.keySet)],
  ]);
}

describe("Connect Microsoft Foundry", () => {
  it("starts with Microsoft's sign-in at the typed directory's own endpoint, with a state and a nonce, and keeps the endpoint", () => {
    const start = foundryPlugin(envWith()).connect.start({ endpoint: `${ENDPOINT}/`, tenantId: TENANT.toUpperCase() }, { userId: "u", appOrigin: APP_ORIGIN, consentState: "state-123" });
    expect(start).toEqual({ kind: "consent", pending: { endpoint: ENDPOINT, signInTenant: TENANT, nonce: expect.stringMatching(/^[0-9a-f]{32}$/) }, open: expect.any(String) });
    if (start.kind !== "consent") throw new Error("a sign-in was expected");
    const link = new URL(start.open);
    // Not `/organizations`, which admits only work or school accounts.
    expect(link.origin + link.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
    expect(Object.fromEntries(link.searchParams)).toEqual({
      client_id: CLIENT_ID, response_type: "code", redirect_uri: `${APP_ORIGIN}${SIGN_IN_RETURN_PATH}`, response_mode: "query", scope: "openid",
      state: "state-123", nonce: start.pending.nonce,
    });
    expect(link.toString()).toBe(signInLink({ clientId: CLIENT_ID, appOrigin: APP_ORIGIN, state: "state-123", nonce: start.pending.nonce!, tenantId: TENANT }));
    // Every Connect has its own nonce.
    const again = foundryPlugin(envWith()).connect.start({ endpoint: ENDPOINT, tenantId: TENANT }, { userId: "u", appOrigin: APP_ORIGIN, consentState: "s" });
    expect(again.kind === "consent" && again.pending.nonce).not.toBe(start.pending.nonce);
  });

  it("refuses the Microsoft account tenant as the directory to sign in to", () => {
    expect(() => foundryPlugin(envWith()).connect.start({ endpoint: ENDPOINT, tenantId: MSA_TENANT }, { userId: "u", appOrigin: APP_ORIGIN, consentState: "s" })).toThrow(/not your Azure directory's/);
  });

  it("redeems a personal account's sign-in with the app's certificate, binds its own directory from the signed token, and sends the user to admin consent there", async () => {
    const { fetcher, sent } = microsoft(await ms.idToken(goodClaims("nonce-1")));
    const next = await foundryPlugin(envWith(), fetcher, () => NOW).connect.finish!(signInPending("nonce-1"), new URLSearchParams({ code: "code-1", state: "s" }), context);
    expect(next).toEqual({
      kind: "consent",
      pending: { endpoint: ENDPOINT, tenantId: TENANT },
      open: adminConsentLink({ clientId: CLIENT_ID, appOrigin: APP_ORIGIN, state: CONSENT, tenantId: TENANT }),
    });
    const link = new URL((next as { open: string }).open);
    expect(link.origin + link.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/adminconsent`);
    expect(Object.fromEntries(link.searchParams)).toEqual({ client_id: CLIENT_ID, redirect_uri: `${APP_ORIGIN}${CONSENT_RETURN_PATH}`, state: CONSENT });

    const f = form(sent[0]!);
    expect(f).toMatchObject({
      client_id: CLIENT_ID, scope: "openid", code: "code-1", redirect_uri: `${APP_ORIGIN}${SIGN_IN_RETURN_PATH}`, grant_type: "authorization_code",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    });
    expect(f.client_secret).toBeUndefined();
    expect(decodeJwt(f.client_assertion!).claims.aud).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(sent[1]!.url).toBe(`https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`);
  });

  it.each([
    ["a bad signature", async () => ms.idToken(goodClaims("n"), { key: await ms.otherKey() }), /signature does not match/],
    ["a key Microsoft does not publish", async () => ms.idToken(goodClaims("n"), { header: { alg: "RS256", kid: "unknown-kid" } }), /not signed with one of Microsoft's keys/],
    ["no signature at all", async () => `${(await ms.idToken(goodClaims("n"), { header: { alg: "none", kid: "ms-key-1" } })).split(".").slice(0, 2).join(".")}.`, /not signed with one of Microsoft's keys/],
    ["another app's audience", async () => ms.idToken(goodClaims("n", { aud: "00000000-0000-4000-8000-000000000099" })), /issued for another app/],
    ["another issuer", async () => ms.idToken(goodClaims("n", { iss: "https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222/v2.0" })), /not issued by Microsoft for that organisation/],
    ["a v1.0 issuer", async () => ms.idToken(goodClaims("n", { iss: `https://sts.windows.net/${TENANT}/` })), /not issued by Microsoft for that organisation/],
    ["an expired token", async () => ms.idToken(goodClaims("n", { exp: t0 - 3600 })), /has expired/],
    ["a token not valid yet", async () => ms.idToken(goodClaims("n", { nbf: t0 + 3600 })), /not valid yet/],
    ["another Connect's nonce", async () => ms.idToken(goodClaims("another-nonce")), /not made for this Connect/],
    ["no nonce", async () => ms.idToken({ ...goodClaims("n"), nonce: undefined }), /not made for this Connect/],
    ["the Microsoft account tenant, outside any Azure directory", async () => ms.idToken(goodClaims("n", { tid: MSA_TENANT, iss: `https://login.microsoftonline.com/${MSA_TENANT}/v2.0` })), /no Azure directory in it/],
    ["no tenant", async () => ms.idToken({ ...goodClaims("n"), tid: undefined }), /no Azure directory in it/],
    ["another directory than the one typed", async () => ms.idToken(goodClaims("n", { tid: "22222222-2222-4222-8222-222222222222", iss: "https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222/v2.0" })), /another directory than the one typed/],
    ["not a token", async () => "not-a-token", /not a signed token/],
    ["a signature that is not base64url", async () => `${(await ms.idToken(goodClaims("n"))).split(".").slice(0, 2).join(".")}.%%%`, /signature does not match/],
  ] as Array<[string, () => Promise<string>, RegExp]>)("refuses an ID token with %s, and asks for nothing more", async (_, token, why) => {
    const { fetcher, sent } = microsoft(await token());
    const error = await foundryPlugin(envWith(), fetcher, () => NOW).connect.finish!(signInPending("n"), new URLSearchParams({ code: "c" }), context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectProblem);
    expect((error as Error).message).toMatch(/^Microsoft's sign-in could not be verified \(/);
    expect((error as Error).message).toMatch(why);
    expect((error as Error).message).toMatch(/nothing was saved/);
    expect(sent.some((s) => /adminconsent/.test(s.url))).toBe(false);
  });

  it.each([
    ["a member of the directory (no idp: the account is homed there)", { idp: undefined }],
    ["a work or school account from another organisation", { idp: "https://sts.windows.net/22222222-2222-4222-8222-222222222222/" }],
    ["an account from another identity provider", { idp: "google.com" }],
    ["an idp that only mentions the Microsoft account tenant", { idp: `https://evil.example.com/${MSA_TENANT}/` }],
  ] as Array<[string, Record<string, unknown>]>)("refuses a work or school sign-in (%s), naming Bedrock and Vertex AI, with no admin consent", async (_, over) => {
    const { fetcher, sent } = microsoft(await ms.idToken({ ...goodClaims("n"), ...over }));
    const error = await foundryPlugin(envWith(), fetcher, () => NOW).connect.finish!(signInPending("n"), new URLSearchParams({ code: "c" }), context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectProblem);
    expect((error as Error).message).toBe(
      "Microsoft Foundry connects here only with a personal Microsoft account, and you signed in with a work or school account, so nothing was saved. Connect Amazon Bedrock or Google Vertex AI instead.",
    );
    expect(sent.some((s) => /adminconsent/.test(s.url))).toBe(false);
  });

  it.each([["live.com"], [`https://login.microsoftonline.com/${MSA_TENANT}/v2.0`], [`https://sts.windows.net/${MSA_TENANT}/`]])(
    "takes a personal account by its idp %s and binds the token's own directory",
    async (idp) => {
      const { fetcher } = microsoft(await ms.idToken(goodClaims("n", { idp })));
      const next = await foundryPlugin(envWith(), fetcher, () => NOW).connect.finish!(signInPending("n"), new URLSearchParams({ code: "c" }), context);
      expect(next).toMatchObject({ kind: "consent", pending: { endpoint: ENDPOINT, tenantId: TENANT } });
    },
  );

  it("says plainly when Microsoft does not answer", async () => {
    const down = (() => Promise.reject(new TypeError("network down"))) as unknown as typeof fetch;
    await expect(foundryPlugin(envWith(), down, () => NOW).connect.finish!(signInPending("n"), new URLSearchParams({ code: "c" }), context)).rejects.toThrow(/did not answer the sign-in/);
    const keysDown = scriptedFetch([
      [/\/oauth2\/v2\.0\/token$/, async () => Response.json({ id_token: await ms.idToken(goodClaims("n")) })],
      [/discovery/, () => Promise.reject(new TypeError("network down"))],
    ]).fetcher;
    await expect(foundryPlugin(envWith(), keysDown, () => NOW).connect.finish!(signInPending("n"), new URLSearchParams({ code: "c" }), context)).rejects.toThrow(/keys could not be fetched/);
  });

  it("says plainly when the sign-in was refused, by the user or by Microsoft", async () => {
    const { connect } = foundryPlugin(envWith(), microsoft(() => Response.json({ error: "invalid_grant", error_description: "AADSTS70008: The provided authorization code or refresh token has expired.\r\nTrace ID: x", error_codes: [70008] }, { status: 400 })).fetcher, () => NOW);
    await expect(connect.finish!(signInPending("n"), new URLSearchParams({ error: "access_denied", error_description: "The user canceled the sign-in" }), context)).rejects.toThrow(/did not complete: The user canceled/);
    await expect(connect.finish!(signInPending("n"), new URLSearchParams({ state: "s" }), context)).rejects.toThrow(/without a sign-in/);
    await expect(connect.finish!(signInPending("n"), new URLSearchParams({ code: "old" }), context)).rejects.toThrow(/did not accept the sign-in: AADSTS70008: The provided authorization code or refresh token has expired\./);
  });

  it("finishes admin consent only in the signed-in tenant: a callback naming another tenant is refused and sets nothing", async () => {
    const { connect } = foundryPlugin(envWith());
    const pending = { endpoint: ENDPOINT, tenantId: TENANT };
    const back = (q: Record<string, string>) => new URLSearchParams(q);
    expect(await connect.finish!(pending, back({ tenant: TENANT.toUpperCase(), admin_consent: "True", state: "s" }), context)).toEqual({ kind: "connection", fields: connection });
    await expect(connect.finish!(pending, back({ tenant: "22222222-2222-4222-8222-222222222222", admin_consent: "True" }), context)).rejects.toThrow(/different organisation than the one you signed in with, so nothing was saved/);
    await expect(connect.finish!(pending, back({ error: "access_denied", error_description: "The admin canceled the request" }), context)).rejects.toThrow(/The admin canceled the request/);
    await expect(connect.finish!(pending, back({ tenant: "contoso.onmicrosoft.com", admin_consent: "True" }), context)).rejects.toThrow(/did not say/);
    await expect(connect.finish!(pending, back({ tenant: TENANT }), context)).rejects.toThrow(/did not say/);
  });

  it("takes only a Foundry resource address and a directory ID", () => {
    const [endpoint, tenant] = foundryPlugin(envWith()).connect.fields;
    const ok = (f: typeof endpoint, v: string) => new RegExp(`^(?:${f!.pattern})$`).test(v);
    expect(ok(endpoint, ENDPOINT)).toBe(true);
    expect(ok(endpoint, "https://evil.example.com/x.services.ai.azure.com")).toBe(false);
    expect(ok(endpoint, "http://example-resource.services.ai.azure.com")).toBe(false);
    expect(tenant!.label).toBe("Directory (tenant) ID");
    expect(ok(tenant, TENANT)).toBe(true);
    expect(ok(tenant, "contoso.onmicrosoft.com")).toBe(false);
  });

  it("cannot start before the app's Entra registration and its credential exist (T10)", () => {
    const start = (over: Record<string, string | undefined>) => () =>
      foundryPlugin(envWith(over)).connect.start({ endpoint: ENDPOINT, tenantId: TENANT }, { userId: "u", appOrigin: APP_ORIGIN, consentState: "s" });
    expect(start({ ENTRA_CLIENT_ID: undefined })).toThrow(/ENTRA_CLIENT_ID/);
    expect(start({ ENTRA_CERT_KEY: undefined })).toThrow(/ENTRA_CERT_KEY/);
    expect(start({ FOUNDRY_CREDENTIAL: "federated", ENTRA_CERT_KEY: undefined, ENTRA_CERT_THUMBPRINT: undefined })).not.toThrow();
  });
});

describe("the Foundry credential", () => {
  it("is a client-credentials token in the user's tenant, proven by a PS256 certificate assertion", async () => {
    const { fetcher, sent } = azure();
    const credential = await foundryPlugin(envWith(), fetcher, () => NOW).mintCredential(connection, { userId: "u" });
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
    await foundryPlugin(envWith({ FOUNDRY_CREDENTIAL: "federated", ENTRA_CERT_KEY: undefined, ENTRA_CERT_THUMBPRINT: undefined }), fetcher, () => NOW).mintCredential(connection, { userId: "u" });
    const { claims, header } = decodeJwt(form(sent[0]!).client_assertion!);
    expect(header.alg).toBe("RS256");
    expect(claims).toMatchObject({ iss: `${APP_ORIGIN}/chief-of-staff/oidc`, aud: ENTRA_FEDERATED_AUDIENCE, sub: ENTRA_SUBJECT });
  });

  it("passes Entra's refusal on with its AADSTS code", async () => {
    const { fetcher } = azure(() =>
      Response.json({ error: "unauthorized_client", error_description: `AADSTS700016: Application with identifier '${CLIENT_ID}' was not found in the directory.\r\nTrace ID: x`, error_codes: [700016] }, { status: 400 }));
    const error = (await foundryPlugin(envWith(), fetcher, () => NOW).mintCredential(connection, { userId: "u" }).catch((e: unknown) => e)) as ProviderRefusal;
    expect(error).toBeInstanceOf(ProviderRefusal);
    expect(error.refusal).toEqual({ step: "token", status: 400, errorName: "AADSTS700016", message: `AADSTS700016: Application with identifier '${CLIENT_ID}' was not found in the directory.` });
  });

  it("is minted only in the tenant on the user's own record, never a multi-tenant alias or a personal account", async () => {
    for (const tenantId of ["organizations", "common", "consumers", "9188040d-6c67-4c5b-b112-36a304b66dad", `${TENANT}/../common`]) {
      const { fetcher, sent } = azure();
      await expect(foundryPlugin(envWith(), fetcher, () => NOW).mintCredential({ ...connection, tenantId }, { userId: "u" }), tenantId).rejects.toThrow(/not one organisation's tenant ID/);
      expect(sent).toEqual([]);
    }
  });

  it("is not configured before the certificate exists (T10)", async () => {
    await expect(foundryPlugin(envWith({ ENTRA_CERT_KEY: undefined })).mintCredential(connection, { userId: "u" })).rejects.toMatchObject({ missing: ["ENTRA_CERT_KEY"] });
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
