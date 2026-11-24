import { beforeAll, describe, expect, it } from "vitest";
import template from "../bedrock-template/template.json";
import { AWS_AUDIENCE, AWS_SUBJECT, bedrockPlugin, BEDROCK_MODEL_IDS, quickCreateLink, ROLE_NAME, STACK_NAME, usageFromConverse } from "../src/providers/bedrock";
import { ProviderRefusal, type Failure } from "../src/proxy/plugin";
import { APP_ORIGIN, decodeJwt, issuerKey, issuerKeys, scriptedFetch, stsCredentials, stsError, type Sent } from "./issuer-fixture";

const NOW = new Date("2026-11-25T10:00:00Z");
const APP_ROLE = "arn:aws:iam::111122223333:role/chief-of-staff-app";
const TEMPLATE_URL = "https://cos-templates.s3.amazonaws.com/chief-of-staff-bedrock-role/v1.0.0.json";
const USER_ROLE = `arn:aws:iam::123456789012:role/${ROLE_NAME}`;
let ISSUER_KEYS: string;

beforeAll(async () => {
  ISSUER_KEYS = issuerKeys("k1", [await issuerKey("k1")]);
});

const envWith = (over: Record<string, string | undefined> = {}) => ({
  APP_ORIGIN, ISSUER_KEYS, AWS_APP_ROLE_ARN: APP_ROLE, AWS_REGION: "us-east-1", BEDROCK_TEMPLATE_URL: TEMPLATE_URL, ...over,
});

const form = (s: Sent) => Object.fromEntries(new URLSearchParams(s.body));

const converseOk = () =>
  Response.json({
    output: { message: { role: "assistant", content: [{ text: "OK" }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 14, outputTokens: 2, totalTokens: 16 },
  });

function aws(converse: (s: Sent) => Response = converseOk, sts: { web?: Response; role?: Response } = {}) {
  return scriptedFetch([
    [/^https:\/\/sts\.us-east-1\.amazonaws\.com\/$/, (s) => {
      const action = form(s).Action;
      if (action === "AssumeRoleWithWebIdentity") return sts.web ?? stsCredentials(action, "ASIAAPP");
      return sts.role ?? stsCredentials("AssumeRole", "ASIAUSER");
    }],
    [/bedrock-runtime/, converse],
  ]);
}

const connection = { roleArn: USER_ROLE, externalId: "0123456789abcdef0123456789abcdef" };

describe("Connect Amazon Bedrock", () => {
  it("makes the record from the account ID: the invoke-only role's ARN and a fresh external ID, and opens the stack", () => {
    const plugin = bedrockPlugin(envWith());
    const start = plugin.connect.start({ accountId: "123456789012" }, { userId: "u", appOrigin: APP_ORIGIN, consentState: "s" });
    expect(start.kind).toBe("connection");
    if (start.kind !== "connection") return;
    expect(start.fields.roleArn).toBe(USER_ROLE);
    expect(start.fields.externalId).toMatch(/^[0-9a-f]{32}$/);
    const link = new URL(start.open!);
    expect(link.origin).toBe("https://us-east-1.console.aws.amazon.com");
    const q = new URLSearchParams(link.hash.split("?")[1]);
    expect(link.hash.startsWith("#/stacks/create/review?")).toBe(true);
    expect(Object.fromEntries(q)).toEqual({ templateURL: TEMPLATE_URL, stackName: STACK_NAME, param_ExternalId: start.fields.externalId, param_AppRoleArn: APP_ROLE });
    // Every external ID is new, unless the same role is connected again.
    const again = plugin.connect.start({ accountId: "123456789012" }, { userId: "u", appOrigin: APP_ORIGIN, consentState: "s", existing: start.fields });
    expect(again.kind === "connection" && again.fields.externalId).toBe(start.fields.externalId);
    const other = plugin.connect.start({ accountId: "123456789013" }, { userId: "u", appOrigin: APP_ORIGIN, consentState: "s", existing: start.fields });
    expect(other.kind === "connection" && other.fields.externalId).not.toBe(start.fields.externalId);
  });

  it("asks only for the 12-digit account ID, and its record holds nothing secret", () => {
    const plugin = bedrockPlugin(envWith());
    expect(plugin.connect.fields.map((f) => f.name)).toEqual(["accountId"]);
    expect(new RegExp(`^${plugin.connect.fields[0]!.pattern}$`).test("12345678901")).toBe(false);
    expect(plugin.connectionFields).toEqual(["roleArn", "externalId"]);
  });

  it("opens no link before the template is published (T10)", () => {
    const start = bedrockPlugin(envWith({ BEDROCK_TEMPLATE_URL: undefined })).connect.start({ accountId: "123456789012" }, { userId: "u", appOrigin: APP_ORIGIN, consentState: "s" });
    expect(start.kind === "connection" && start.open).toBeUndefined();
  });

  it("builds the link the template's own parameters expect", () => {
    const link = quickCreateLink({ region: "eu-west-1", templateUrl: TEMPLATE_URL, appRoleArn: APP_ROLE, externalId: "x1" });
    const names = [...new URLSearchParams(new URL(link).hash.split("?")[1]).keys()].filter((k) => k.startsWith("param_")).map((k) => k.slice(6));
    expect(names.sort()).toEqual(Object.keys(template.Parameters).sort());
  });
});

describe("the Bedrock role template", () => {
  const role = template.Resources.ModelCallerRole.Properties;
  it("carries one version, in its metadata and its outputs", () => {
    expect(template.Metadata.TemplateVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(template.Outputs.TemplateVersion.Value).toBe(template.Metadata.TemplateVersion);
  });

  it("makes the role the app expects, trusting only the app's role and only with the external ID", () => {
    expect(role.RoleName).toBe(ROLE_NAME);
    expect(role.MaxSessionDuration).toBe(3600);
    expect(role.AssumeRolePolicyDocument.Statement).toEqual([
      { Effect: "Allow", Principal: { AWS: { Ref: "AppRoleArn" } }, Action: "sts:AssumeRole", Condition: { StringEquals: { "sts:ExternalId": { Ref: "ExternalId" } } } },
    ]);
  });

  it("allows model invocation and reading its own stack, nothing else", () => {
    const statements = role.Policies.flatMap((p) => p.PolicyDocument.Statement);
    expect(statements.flatMap((s) => [s.Action].flat()).sort()).toEqual(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "cloudformation:DescribeStacks"]);
    expect(statements.find((s) => s.Action === "cloudformation:DescribeStacks")!.Resource).toEqual({ Ref: "AWS::StackId" });
    expect(statements.every((s) => s.Effect === "Allow")).toBe(true);
  });
});

describe("the Bedrock credential", () => {
  it("trades the issuer's token for the app's role, unsigned, then chains to the user's role with the external ID, signed", async () => {
    const { fetcher, sent } = aws();
    const credential = await bedrockPlugin(envWith(), fetcher, () => NOW).mintCredential(connection);
    expect(credential).toMatchObject({ accessKeyId: "ASIAUSER", secretAccessKey: "secret-ASIAUSER", sessionToken: "token-ASIAUSER" });
    const [web, role] = sent;
    expect(web!.headers.get("authorization")).toBeNull();
    const w = form(web!);
    expect(w).toMatchObject({ Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: APP_ROLE, DurationSeconds: "3600" });
    expect(decodeJwt(w.WebIdentityToken!).claims).toMatchObject({ iss: `${APP_ORIGIN}/oidc`, aud: AWS_AUDIENCE, sub: AWS_SUBJECT });
    const r = form(role!);
    expect(r).toMatchObject({ Action: "AssumeRole", RoleArn: USER_ROLE, ExternalId: connection.externalId, DurationSeconds: "3600" });
    expect(role!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAAPP\/20261125\/us-east-1\/sts\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    expect(role!.headers.get("x-amz-security-token")).toBe("token-ASIAAPP");
  });

  it("passes STS's own refusal on, naming the exchange", async () => {
    const { fetcher } = aws(converseOk, { role: stsError("AccessDenied", "User: arn:aws:sts::111122223333:assumed-role/chief-of-staff-app/chief-of-staff is not authorized to perform: sts:AssumeRole") });
    const error = (await bedrockPlugin(envWith(), fetcher, () => NOW).mintCredential(connection).catch((e: unknown) => e)) as ProviderRefusal;
    expect(error).toBeInstanceOf(ProviderRefusal);
    expect(error.refusal).toEqual({ step: "AssumeRole", status: 403, errorName: "AccessDenied", message: expect.stringContaining("not authorized to perform: sts:AssumeRole") });
  });

  it("is not configured before T10's app role and issuer key", async () => {
    await expect(bedrockPlugin(envWith({ AWS_APP_ROLE_ARN: undefined })).mintCredential(connection)).rejects.toMatchObject({ missing: ["AWS_APP_ROLE_ARN"] });
    await expect(bedrockPlugin(envWith({ ISSUER_KEYS: undefined })).mintCredential(connection)).rejects.toMatchObject({ missing: ["ISSUER_KEYS"] });
  });
});

describe("the Bedrock caller", () => {
  const credential = { accessKeyId: "ASIAUSER", secretAccessKey: "s", sessionToken: "t" };

  it("calls Converse on the Global profile, signed with the user's one-hour credentials", async () => {
    const { fetcher, sent } = aws();
    const plugin = bedrockPlugin(envWith(), fetcher, () => NOW);
    const reply = await plugin.call({ credential, connection, model: "Claude Haiku 5.5", location: "global", request: plugin.connect.testRequest("Claude Haiku 5.5", "global") });
    expect(reply.status).toBe(200);
    expect(sent[0]!.url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-haiku-5-5/converse");
    expect(sent[0]!.headers.get("authorization")).toMatch(/Credential=ASIAUSER\/20261125\/us-east-1\/bedrock\/aws4_request/);
    expect(JSON.parse(sent[0]!.body)).toEqual({ messages: [{ role: "user", content: [{ text: "Reply with the single word OK." }] }], inferenceConfig: { maxTokens: 5 } });
    expect(reply.usage).toEqual({ input: 14, cachedInput: 0, cacheWrite: 0, cacheWrite1h: 0, output: 2, longPrompt: false });
    expect(plugin.connect.replyText(reply.body)).toBe("OK");
  });

  it("uses the cross-Region profile of the app's geography, and encodes model IDs in the path", async () => {
    const { fetcher, sent } = aws();
    const plugin = bedrockPlugin(envWith({ AWS_REGION: "eu-west-1" }), fetcher, () => NOW);
    await plugin.call({ credential, connection, model: "Claude Haiku 4.5", location: "cross-region", request: {} });
    expect(sent[0]!.url).toBe("https://bedrock-runtime.eu-west-1.amazonaws.com/model/eu.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse");
    expect(BEDROCK_MODEL_IDS["Claude Sonnet 5.5"]).toBe("anthropic.claude-sonnet-5-5");
  });

  it("reads the cache writes by lifetime, and counts unsplit writes as 1-hour ones", () => {
    const body = { usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5000, cacheWriteInputTokens: 3000, cacheDetails: [{ ttl: "1h", inputTokens: 1000 }, { ttl: "5m", inputTokens: 1500 }] } };
    expect(usageFromConverse(body, "global.anthropic.claude-sonnet-5-5")).toEqual({ input: 100, cachedInput: 5000, cacheWrite: 1500, cacheWrite1h: 1500, output: 20, longPrompt: false });
    expect(usageFromConverse({ usage: { inputTokens: 1, outputTokens: 1, cacheWriteInputTokens: 700 } }, "x")).toMatchObject({ cacheWrite: 0, cacheWrite1h: 700 });
  });

  it("marks a Claude Haiku 5.5 prompt over 100,000 tokens, cache included, as long", () => {
    const usage = (input: number, cached: number) => usageFromConverse({ usage: { inputTokens: input, outputTokens: 1, cacheReadInputTokens: cached } }, "global.anthropic.claude-haiku-5-5")!;
    expect(usage(60_000, 40_000).longPrompt).toBe(false);
    expect(usage(60_000, 40_001).longPrompt).toBe(true);
    expect(usageFromConverse({ usage: { inputTokens: 900_000, outputTokens: 1 } }, "global.anthropic.claude-sonnet-5-5")!.longPrompt).toBe(false);
  });

  it("hands back the provider's error name and message", async () => {
    const { fetcher } = aws(() => Response.json({ message: "Marketplace Agreement Pending" }, { status: 403, headers: { "x-amzn-ErrorType": "AccessDeniedException:http://internal.amazon.com/coral/com.amazon.bedrock/" } }));
    const reply = await bedrockPlugin(envWith(), fetcher, () => NOW).call({ credential, connection, model: "Claude Haiku 5.5", location: "global", request: {} });
    expect(reply).toMatchObject({ status: 403, error: { name: "AccessDeniedException", message: "Marketplace Agreement Pending" } });
    expect(reply.usage).toBeUndefined();
  });
});

describe("Bedrock's plain reasons", () => {
  const classify = (f: Partial<Failure>) => bedrockPlugin(envWith()).connect.classify({ step: "call", status: 400, errorName: "", message: "", ...f }, connection);
  it.each([
    [{ step: "credential", exchange: "AssumeRole", status: 403, errorName: "AccessDenied" }, "not_set_up"],
    [{ step: "credential", exchange: "AssumeRoleWithWebIdentity", status: 400, errorName: "InvalidIdentityToken" }, "app_not_configured"],
    [{ status: 403, errorName: "AccessDeniedException", message: "Marketplace Agreement Pending" }, "switching_on"],
    [{ status: 403, errorName: "MPAgreementBeingCreated" }, "switching_on"],
    [{ status: 404, errorName: "FTUFormNotFilled" }, "not_allowed_yet"],
    [{ status: 403, errorName: "AccessDeniedException", message: "You don't have access to the model with the specified model ID." }, "not_allowed_yet"],
    [{ status: 404, errorName: "ResourceNotFoundException" }, "no_such_model"],
    [{ status: 403, errorName: "AccessDeniedException", message: "not authorized to perform bedrock:InvokeModel" }, "no_permission"],
    [{ status: 429, errorName: "ThrottlingException" }, "busy"],
    [{ status: 400, errorName: "ValidationException" }, "refused"],
  ] as Array<[Partial<Failure>, string]>)("%j is %s", (f, reason) => {
    expect(classify(f).reason).toBe(reason);
  });

  it("offers the stack again when the role is missing", () => {
    const plain = classify({ step: "credential", exchange: "AssumeRole", status: 403, errorName: "AccessDenied" });
    expect(plain.fix).toBe("Create the stack again with Connect Amazon Bedrock, then try again.");
    expect(plain.links[0]!.label).toBe("Connect Amazon Bedrock");
    expect(new URL(plain.links[0]!.href).hash).toContain(`param_ExternalId=${connection.externalId}`);
  });
});

describe("the template version in the user's own stack", () => {
  it("is read from the stack's outputs with the user's credentials", async () => {
    const { fetcher, sent } = scriptedFetch([
      [/cloudformation\.us-east-1/, () => new Response(`<DescribeStacksResponse><DescribeStacksResult><Stacks><member><Outputs>
<member><OutputKey>RoleArn</OutputKey><OutputValue>${USER_ROLE}</OutputValue></member>
<member><OutputKey>TemplateVersion</OutputKey><OutputValue>1.0.0</OutputValue></member>
</Outputs></member></Stacks></DescribeStacksResult></DescribeStacksResponse>`)],
    ]);
    const version = await bedrockPlugin(envWith(), fetcher, () => NOW).connect.readSetupVersion!({ accessKeyId: "ASIAUSER", secretAccessKey: "s", sessionToken: "t" }, connection);
    expect(version).toBe("1.0.0");
    expect(Object.fromEntries(new URLSearchParams(sent[0]!.body))).toEqual({ Action: "DescribeStacks", Version: "2010-05-15", StackName: STACK_NAME });
    expect(sent[0]!.headers.get("authorization")).toMatch(/\/cloudformation\/aws4_request/);
  });
});
