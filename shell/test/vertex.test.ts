import { beforeAll, describe, expect, it } from "vitest";
import { userPrincipal, wifAudience } from "../src/google-federation";
import { customRoleCommand, rawPredictUrl, vertexModelId, vertexPlugin } from "../src/providers/vertex";
import { vertexDefaultLocation } from "../src/providers/vertex-locations";
import { ProviderRefusal, type Failure } from "../src/proxy/plugin";
import { APP_ORIGIN, decodeJwt, issuerKey, issuerKeys, scriptedFetch, type Sent } from "./issuer-fixture";

const NOW = new Date("2026-11-25T10:00:00Z");
const WIF = "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/chief-of-staff/providers/chief-of-staff-worker";
// Two users' app IDs, as src/users.ts makes them.
const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_B = "bbbbbbbb-2222-4222-8222-222222222222";
const principalOf = (user: string) => `principal://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/chief-of-staff/subject/${user}`;
const connection = { projectId: "example-project-123" };
let ISSUER_KEYS: string;

beforeAll(async () => {
  ISSUER_KEYS = issuerKeys("k1", [await issuerKey("k1")]);
});

const envWith = (over: Record<string, string | undefined> = {}) => ({ APP_ORIGIN, ISSUER_KEYS, GOOGLE_WIF_PROVIDER: WIF, ...over });

const claudeOk = () => Response.json({ id: "msg_1", type: "message", content: [{ type: "text", text: "OK" }], usage: { input_tokens: 11, output_tokens: 2 } });

// Google's STS answers each subject token with that subject's own federated token.
function google(predict: (s: Sent) => Response = claudeOk, sts?: Response) {
  return scriptedFetch([
    [/^https:\/\/sts\.googleapis\.com\/v1\/token$/, (s) =>
      sts ?? Response.json({ access_token: `federated-token-for-${decodeJwt(JSON.parse(s.body).subjectToken).claims.sub}`, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 3599 })],
    [/aiplatform/, predict],
  ]);
}

describe("Connect Google Vertex AI", () => {
  it("stores only the project ID, and shows the user's own identity to grant, with the one-permission role command", () => {
    const plugin = vertexPlugin(envWith());
    expect(plugin.connectionFields).toEqual(["projectId"]);
    expect(plugin.connect.start({ projectId: "example-project-123" }, { userId: USER_A, appOrigin: APP_ORIGIN, consentState: "s" })).toEqual({ kind: "connection", fields: connection });
    const shown = plugin.connect.grantHelp!({ userId: USER_A });
    expect(shown).toContain(`Your own identity: <span class="mono" style="word-break:break-all">${principalOf(USER_A)}</span>`);
    expect(shown).toContain(`data-copy="${principalOf(USER_A)}"`);
    expect(shown).not.toContain("gserviceaccount.com");
    // Each user sees their own, never another's.
    expect(plugin.connect.grantHelp!({ userId: USER_B })).toContain(principalOf(USER_B));
    expect(plugin.connect.grantHelp!({ userId: USER_B })).not.toContain(USER_A);
    expect(plugin.connect.grantHelp!({ userId: USER_A, connection })).toContain("--project=example-project-123");
    expect(customRoleCommand("p-1")).toBe('gcloud iam roles create chiefOfStaffModelCaller --project=p-1 --title="Chief of staff model caller" --permissions=aiplatform.endpoints.predict');
  });

  it("takes only a Google project ID", () => {
    const f = vertexPlugin(envWith()).connect.fields[0]!;
    const ok = (v: string) => new RegExp(`^(?:${f.pattern})$`).test(v);
    expect(ok("example-project-123")).toBe(true);
    for (const bad of ["Example", "abc", "1project", "project-", "a".repeat(31)]) expect(ok(bad), bad).toBe(false);
  });
});

describe("the user's own Google identity", () => {
  it("is the pool's principal whose subject is the user's app ID, derived from GOOGLE_WIF_PROVIDER", () => {
    expect(userPrincipal(WIF, USER_A)).toBe(principalOf(USER_A));
    expect(userPrincipal(undefined, USER_A)).toBeUndefined();
    expect(userPrincipal("projects/1/pools/p", USER_A)).toBeUndefined();
    expect(userPrincipal(WIF, "a/b")).toBeUndefined();
    expect(vertexPlugin(envWith({ GOOGLE_WIF_PROVIDER: undefined })).connect.grantHelp!({ userId: USER_A })).toContain("shown once Admin has set up the app's Google identity");
  });
});

describe("the Vertex AI credential", () => {
  it("exchanges a token whose subject is the user's own app ID at Google's STS, and uses that federated token directly", async () => {
    const { fetcher, sent } = google();
    expect(await vertexPlugin(envWith(), fetcher, () => NOW).mintCredential(connection, { userId: USER_A })).toEqual({ accessToken: `federated-token-for-${USER_A}`, expiresIn: 3599 });
    expect(sent).toHaveLength(1);
    expect(sent.some((s) => /iamcredentials|generateAccessToken/.test(s.url))).toBe(false);
    const [sts] = sent;
    expect(sts!.headers.get("authorization")).toBeNull();
    const body = JSON.parse(sts!.body);
    expect(body).toMatchObject({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: WIF,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
    });
    const { header, claims } = decodeJwt(body.subjectToken);
    expect(header).toMatchObject({ alg: "RS256", kid: "k1" });
    expect(claims).toMatchObject({ iss: `${APP_ORIGIN}/chief-of-staff/oidc`, aud: wifAudience(WIF), sub: USER_A });
    expect(claims.aud).toBe(`https:${WIF}`);
  });

  it("gives two users different subjects, so user B naming user A's project calls as B's principal, never A's", async () => {
    const { fetcher, sent } = google((s) =>
      // A's project grants only A's principal.
      s.headers.get("authorization") === `Bearer federated-token-for-${USER_A}`
        ? claudeOk()
        : Response.json({ error: { code: 403, message: "Permission denied on resource project example-project-123.", status: "PERMISSION_DENIED" } }, { status: 403 }));
    const plugin = vertexPlugin(envWith(), fetcher, () => NOW);
    const asA = await plugin.mintCredential(connection, { userId: USER_A });
    const asB = await plugin.mintCredential(connection, { userId: USER_B });
    const subjects = sent.map((s) => decodeJwt(JSON.parse(s.body).subjectToken).claims.sub);
    expect(subjects).toEqual([USER_A, USER_B]);
    const request = plugin.connect.testRequest("Claude Haiku 5.5", "us");
    expect((await plugin.call({ credential: asA, connection, model: "Claude Haiku 5.5", location: "us", request })).status).toBe(200);
    const b = await plugin.call({ credential: asB, connection, model: "Claude Haiku 5.5", location: "us", request });
    expect(b).toMatchObject({ status: 403, error: { name: "PERMISSION_DENIED" } });
    expect(sent.at(-1)!.headers.get("authorization")).toBe(`Bearer federated-token-for-${USER_B}`);
  });

  it("passes Google's refusal on", async () => {
    const { fetcher } = google(claudeOk, Response.json({ error: "invalid_grant", error_description: "The given credential is rejected by the attribute condition." }, { status: 400 }));
    const error = (await vertexPlugin(envWith(), fetcher, () => NOW).mintCredential(connection, { userId: USER_A }).catch((e: unknown) => e)) as ProviderRefusal;
    expect(error).toBeInstanceOf(ProviderRefusal);
    expect(error.refusal).toMatchObject({ step: "sts.googleapis.com token", status: 400 });
  });

  it("needs only T10's pool, no service account, and never mints without the user's own app ID", async () => {
    await expect(vertexPlugin(envWith({ GOOGLE_WIF_PROVIDER: undefined })).mintCredential(connection, { userId: USER_A })).rejects.toMatchObject({ missing: ["GOOGLE_WIF_PROVIDER"] });
    const { fetcher, sent } = google();
    await expect(vertexPlugin(envWith(), fetcher, () => NOW).mintCredential(connection, { userId: "" })).rejects.toThrow(/user's own app ID/);
    // Nor as the price reader, nor as anything but an app ID.
    for (const userId of ["price-reader", "user-1", USER_A.toUpperCase()]) {
      await expect(vertexPlugin(envWith(), fetcher, () => NOW).mintCredential(connection, { userId })).rejects.toThrow(/user's own app ID/);
    }
    expect(sent).toEqual([]);
  });
});

describe("the Vertex AI caller", () => {
  it("calls rawPredict on the user's project at the multi-region, the global or a regional host", () => {
    expect(rawPredictUrl("p", "us", "claude-haiku-5-5")).toBe("https://aiplatform.us.rep.googleapis.com/v1/projects/p/locations/us/publishers/anthropic/models/claude-haiku-5-5:rawPredict");
    expect(rawPredictUrl("p", "global", "m")).toBe("https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/anthropic/models/m:rawPredict");
    expect(rawPredictUrl("p", "us-east5", "m")).toBe("https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic/models/m:rawPredict");
  });

  it("sends Anthropic's body with Vertex's version and no model field", async () => {
    const { fetcher, sent } = google();
    const plugin = vertexPlugin(envWith(), fetcher, () => NOW);
    const reply = await plugin.call({ credential: { accessToken: "sa-token" }, connection, model: "Claude Haiku 5.5", location: "us", request: { model: "x", max_tokens: 5, messages: [] } });
    expect(sent[0]!.url).toBe(rawPredictUrl("example-project-123", "us", "claude-haiku-5-5"));
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer sa-token");
    expect(JSON.parse(sent[0]!.body)).toEqual({ anthropic_version: "vertex-2023-10-16", max_tokens: 5, messages: [] });
    expect(reply.usage).toEqual({ input: 11, cachedInput: 0, cacheWrite: 0, cacheWrite1h: 0, output: 2, longPrompt: false });
    expect(plugin.connect.replyText(reply.body)).toBe("OK");
  });

  it("names the app's default location for each model: the us multi-region for Claude 4.7 and later, us-east5 for older Claude", () => {
    const plugin = vertexPlugin(envWith());
    expect(plugin.connect.locations("Claude Haiku 5.5")).toEqual(["us", "eu", "global"]);
    expect(vertexDefaultLocation("Claude Opus 4.7")).toBe("us");
    expect(vertexDefaultLocation("Claude Opus 4.6")).toBe("us-east5");
    expect(vertexDefaultLocation("Gemini 3.8 Flash")).toBe("us");
    expect(vertexDefaultLocation("Unknown model")).toBeUndefined();
    expect(plugin.connect.locations("Unknown model")).toEqual(["global"]);
    expect(vertexModelId("Claude Sonnet 5.5")).toBe("claude-sonnet-5-5");
  });

  it("hands back Google's error, unwrapping an array", async () => {
    const { fetcher } = google(() => Response.json([{ error: { code: 403, message: "Permission denied on resource project example-project-123.", status: "PERMISSION_DENIED" } }], { status: 403 }));
    const reply = await vertexPlugin(envWith(), fetcher).call({ credential: { accessToken: "t" }, connection, model: "Claude Haiku 5.5", location: "us", request: {} });
    expect(reply.error).toEqual({ name: "PERMISSION_DENIED", message: "Permission denied on resource project example-project-123." });
  });
});

describe("Vertex AI's plain reasons", () => {
  const classify = (f: Partial<Failure>) => vertexPlugin(envWith()).connect.classify({ step: "call", status: 400, errorName: "", message: "", ...f }, connection);
  it.each([
    [{ step: "credential", status: 400, errorName: "invalid_grant" }, "app_not_configured"],
    [{ status: 403, errorName: "PERMISSION_DENIED", message: "Permission denied on resource project example-project-123." }, "not_set_up"],
    [{ status: 403, errorName: "PERMISSION_DENIED", message: "Claude is not enabled for this project in Model Garden." }, "not_allowed_yet"],
    [{ status: 403, errorName: "PERMISSION_DENIED", message: "Vertex AI API has not been used in project 1 before or it is disabled." }, "not_allowed_yet"],
    [{ status: 404, errorName: "NOT_FOUND" }, "no_such_model"],
    [{ status: 429, errorName: "RESOURCE_EXHAUSTED" }, "busy"],
    [{ status: 400, errorName: "INVALID_ARGUMENT" }, "refused"],
  ] as Array<[Partial<Failure>, string]>)("%j is %s", (f, reason) => {
    expect(classify(f).reason).toBe(reason);
  });

  it("links the user's own project's IAM page", () => {
    expect(classify({ status: 403, errorName: "PERMISSION_DENIED" }).links).toEqual([{ label: "Open IAM → Grant access", href: "https://console.cloud.google.com/iam-admin/iam?project=example-project-123" }]);
  });
});
