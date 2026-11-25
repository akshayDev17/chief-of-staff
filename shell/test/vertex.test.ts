import { beforeAll, describe, expect, it } from "vitest";
import { customRoleCommand, GOOGLE_SUBJECT, rawPredictUrl, vertexModelId, vertexPlugin, wifAudience } from "../src/providers/vertex";
import { vertexDefaultLocation } from "../src/providers/vertex-locations";
import { ProviderRefusal, type Failure } from "../src/proxy/plugin";
import { APP_ORIGIN, decodeJwt, issuerKey, issuerKeys, scriptedFetch, type Sent } from "./issuer-fixture";

const NOW = new Date("2026-11-25T10:00:00Z");
const WIF = "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/chief-of-staff/providers/chief-of-staff-worker";
const SA = "chief-of-staff-models@cos-owner-project.iam.gserviceaccount.com";
const connection = { projectId: "example-project-123" };
let ISSUER_KEYS: string;

beforeAll(async () => {
  ISSUER_KEYS = issuerKeys("k1", [await issuerKey("k1")]);
});

const envWith = (over: Record<string, string | undefined> = {}) => ({ APP_ORIGIN, ISSUER_KEYS, GOOGLE_WIF_PROVIDER: WIF, GOOGLE_SERVICE_ACCOUNT: SA, ...over });

const claudeOk = () => Response.json({ id: "msg_1", type: "message", content: [{ type: "text", text: "OK" }], usage: { input_tokens: 11, output_tokens: 2 } });

function google(predict: (s: Sent) => Response = claudeOk, sts?: Response, iam?: Response) {
  return scriptedFetch([
    [/^https:\/\/sts\.googleapis\.com\/v1\/token$/, () => sts ?? Response.json({ access_token: "federated-token", issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 3599 })],
    [/^https:\/\/iamcredentials\.googleapis\.com\//, () => iam ?? Response.json({ accessToken: "sa-token", expireTime: "2026-11-25T11:00:00Z" })],
    [/aiplatform/, predict],
  ]);
}

describe("Connect Google Vertex AI", () => {
  it("stores only the project ID, and shows the service account and the one-permission role command", () => {
    const plugin = vertexPlugin(envWith());
    expect(plugin.connectionFields).toEqual(["projectId"]);
    expect(plugin.connect.start({ projectId: "example-project-123" }, { userId: "u", appOrigin: APP_ORIGIN, consentState: "s" })).toEqual({ kind: "connection", fields: connection });
    const shown = plugin.connect.grantHelp!();
    expect(shown).toContain(SA);
    expect(shown).toContain('data-copy="chief-of-staff-models@cos-owner-project.iam.gserviceaccount.com"');
    expect(customRoleCommand("p-1")).toBe('gcloud iam roles create chiefOfStaffModelCaller --project=p-1 --title="Chief of staff model caller" --permissions=aiplatform.endpoints.predict');
  });

  it("takes only a Google project ID", () => {
    const f = vertexPlugin(envWith()).connect.fields[0]!;
    const ok = (v: string) => new RegExp(`^(?:${f.pattern})$`).test(v);
    expect(ok("example-project-123")).toBe(true);
    for (const bad of ["Example", "abc", "1project", "project-", "a".repeat(31)]) expect(ok(bad), bad).toBe(false);
  });
});

describe("the Vertex AI credential", () => {
  it("exchanges the issuer's token at Google's STS, then gets the service account's 1-hour token", async () => {
    const { fetcher, sent } = google();
    expect(await vertexPlugin(envWith(), fetcher, () => NOW).mintCredential(connection)).toMatchObject({ accessToken: "sa-token" });
    const [sts, iam] = sent;
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
    expect(claims).toMatchObject({ iss: `${APP_ORIGIN}/chief-of-staff/oidc`, aud: wifAudience(WIF), sub: GOOGLE_SUBJECT });
    expect(claims.aud).toBe(`https:${WIF}`);
    expect(iam!.url).toBe(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SA)}:generateAccessToken`);
    expect(iam!.headers.get("authorization")).toBe("Bearer federated-token");
    expect(JSON.parse(iam!.body)).toEqual({ scope: ["https://www.googleapis.com/auth/cloud-platform"], lifetime: "3600s" });
  });

  it("passes Google's refusal on", async () => {
    const { fetcher } = google(claudeOk, undefined, Response.json({ error: { code: 403, message: "Permission 'iam.serviceAccounts.getAccessToken' denied", status: "PERMISSION_DENIED" } }, { status: 403 }));
    const error = (await vertexPlugin(envWith(), fetcher, () => NOW).mintCredential(connection).catch((e: unknown) => e)) as ProviderRefusal;
    expect(error).toBeInstanceOf(ProviderRefusal);
    expect(error.refusal).toMatchObject({ step: "generateAccessToken", status: 403, errorName: "PERMISSION_DENIED" });
  });

  it("is not configured before T10's pool and service account", async () => {
    await expect(vertexPlugin(envWith({ GOOGLE_WIF_PROVIDER: undefined, GOOGLE_SERVICE_ACCOUNT: undefined })).mintCredential(connection)).rejects.toMatchObject({
      missing: ["GOOGLE_WIF_PROVIDER", "GOOGLE_SERVICE_ACCOUNT"],
    });
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
