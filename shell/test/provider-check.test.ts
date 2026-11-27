import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addModel } from "../src/models/add";
import { PROVIDERS_PATH } from "../src/paths";
import { handleProviders } from "../src/providers/page";
import { readAccountCheck } from "../src/providers/bedrock-account";
import type { BedrockCatalog, CatalogRead } from "../src/providers/bedrock-catalog";
import { readBedrockOffer } from "../src/providers/bedrock-catalog";
import { askAdminForHelp, chooseRegion, connectProvider, disconnectProvider, finishConsent, readCheck, runCheck, runDueChecks } from "../src/providers/check";
import { bedrockPlugin, TEST_MODEL } from "../src/providers/bedrock";
import type { BedrockOffer, ModelOffer } from "../src/providers/bedrock-catalog";
import { foundryPlugin } from "../src/providers/foundry";
import { writeSnapshot } from "../src/prices/store";
import type { PriceRow } from "../src/prices/types";
import { setBudget } from "../src/proxy/budgets";
import { readConnection, writeConnection } from "../src/proxy/connections";
import { callModel } from "../src/proxy/proxy";
import { APP_ORIGIN, fakeMicrosoft, issuerKey, issuerKeys, scriptedFetch, stsCredentials, stsError, type Sent } from "./issuer-fixture";
import { dumpEveryTable, testPlugin, userFor } from "./test-plugin";

const T0 = new Date("2026-11-25T10:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
let ISSUER_KEYS: string;
let userId: string;

beforeAll(async () => {
  ISSUER_KEYS = issuerKeys("k1", [await issuerKey("k1")]);
});

const price = (provider: PriceRow["provider"], model: string, tokenKind: PriceRow["tokenKind"], usdPerMTok: number, deployment: PriceRow["deployment"] = "global"): PriceRow => ({
  provider, model, deployment, region: deployment === "global" ? "us-east-1" : "us-east-1", tokenKind, longPrompt: false, batch: false, usdPerMTok,
  source: "aws-price-list", dateRead: "2026-11-24", stale: false, disagreement: false,
});

beforeEach(async () => {
  userId = (await userFor("owner-sub")).id;
  await writeSnapshot(env.DB, {
    takenAt: "2026-11-24T06:00:00Z",
    status: "good",
    results: [],
    rows: [
      price("bedrock", "Nova 2.0 Lite", "input", 0.1),
      price("bedrock", "Nova 2.0 Lite", "output", 0.5),
      { ...price("bedrock", "Nova 2.0 Lite", "input", 0.11, "regional"), region: "us-east-1" },
      { ...price("bedrock", "Nova 2.0 Lite", "output", 0.55, "regional"), region: "us-east-1" },
      { ...price("foundry", "Claude Haiku 5.5", "input", 0.1), region: "global", source: "maintainer-read" },
      { ...price("foundry", "Claude Haiku 5.5", "output", 0.5), region: "global", source: "maintainer-read" },
    ],
  });
});

// AWS as the scenario has it: whether the user's stack exists, and what Converse says.
function awsWorld(offer?: BedrockOffer) {
  const world = {
    stack: false,
    template: "1.0.0",
    // Bedrock's control plane in the user's account (Refresh model list).
    useCase: (): Response => Response.json({ message: "You have not filled out the request form." }, { status: 404, headers: { "x-amzn-ErrorType": "ResourceNotFoundException" } }),
    availability: (_modelId: string): Response => Response.json({ agreementAvailability: { status: "AVAILABLE" }, authorizationStatus: "AUTHORIZED", entitlementAvailability: "AVAILABLE", regionAvailability: "AVAILABLE" }),
    converse: (_sent: Sent): Response => Response.json({ output: { message: { content: [{ text: "OK" }] } }, usage: { inputTokens: 38, outputTokens: 3 } }) };
  const { fetcher, sent } = scriptedFetch([
    [/sts\.us-east-1/, (s: Sent) => {
      const action = new URLSearchParams(s.body).get("Action");
      if (action === "AssumeRoleWithWebIdentity") return stsCredentials(action, "ASIAAPP");
      return world.stack ? stsCredentials("AssumeRole", "ASIAUSER") : stsError("AccessDenied", "User: arn:aws:sts::111122223333:assumed-role/chief-of-staff-app/chief-of-staff is not authorized to perform: sts:AssumeRole");
    }],
    [/bedrock-runtime/, (s: Sent) => world.converse(s)],
    [/cloudformation/, () => new Response(`<Outputs><member><OutputKey>TemplateVersion</OutputKey><OutputValue>${world.template}</OutputValue></member></Outputs>`)],
    [/^https:\/\/bedrock\.us-east-1\.amazonaws\.com\/use-case-for-model-access$/, () => world.useCase()],
    [/^https:\/\/bedrock\.us-east-1\.amazonaws\.com\/foundation-model-availability\//, (s: Sent) => world.availability(decodeURIComponent(s.url.split("/").at(-1)!))],
  ]);
  const plugins = {
    bedrock: bedrockPlugin({ APP_ORIGIN, ISSUER_KEYS, AWS_APP_ROLE_ARN: "arn:aws:iam::111122223333:role/chief-of-staff-app", BEDROCK_TEMPLATE_URL: "https://t.example/v1.0.0.json" }, fetcher, () => T0, offer),
  };
  return { world, plugins, sent };
}

const connectBedrock = (plugins: ReturnType<typeof awsWorld>["plugins"], now = T0) =>
  connectProvider(env.DB, plugins, { userId, provider: "bedrock", typed: { accountId: "123456789012" }, appOrigin: APP_ORIGIN, now });

const ledger = async () => (await env.DB.prepare("SELECT * FROM model_calls WHERE user_id = ? ORDER BY id").bind(userId).all<Record<string, unknown>>()).results;

describe("the automatic test call", () => {
  it("waits for the stack, polling every minute, then passes by itself and ticks the item", async () => {
    const { world, plugins } = awsWorld();
    const outcome = await connectBedrock(plugins);
    expect("open" in outcome && outcome.open).toMatch(/^https:\/\/us-east-1\.console\.aws\.amazon\.com\/cloudformation\//);
    let check = await readCheck(env.DB, userId, "bedrock");
    expect(check).toMatchObject({ state: "checking", region: "global", regionSetBy: "app", nextTryAt: at(1).toISOString() });
    expect(check!.result).toMatchObject({
      verdict: "failed", reason: "not_set_up", model: "Nova 2.0 Lite", modelId: "global.amazon.nova-2-lite-v1:0",
      reply: { status: 403, errorName: "AccessDenied", message: expect.stringContaining("not authorized to perform: sts:AssumeRole") },
      fix: "Create the stack again with Connect Amazon Bedrock, then try again.",
    });
    // Nothing reached a model, so nothing is in the ledger.
    expect(await ledger()).toEqual([]);

    world.stack = true;
    expect(await runDueChecks(env.DB, plugins, at(1))).toBe(1);
    check = await readCheck(env.DB, userId, "bedrock");
    expect(check).toMatchObject({ state: "passed", passedAt: at(1).toISOString(), templateVersion: "1.0.0" });
    expect(check!.nextTryAt).toBeUndefined();
    expect(check!.result).toMatchObject({ verdict: "passed", reply: { status: 200, text: "OK" }, usage: { input: 38, output: 3 } });
    expect(check!.result!.costUsd).toBeCloseTo((38 * 0.1 + 3 * 0.5) / 1e6, 12);
    // The test call is a real call: one ledger row, costed at the list price.
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task: "test_call", provider: "bedrock", model: "Nova 2.0 Lite", region: "global", status: 200, plugin_version: "bedrock-1.0.0", input_tokens: 38, output_tokens: 3, fallback: 0 });
    // Nothing more is due.
    expect(await runDueChecks(env.DB, plugins, at(30))).toBe(0);
  });

  it("stops polling an hour after Connect, leaving Try again", async () => {
    const { plugins } = awsWorld();
    await connectBedrock(plugins);
    await runCheck(env.DB, plugins, userId, "bedrock", at(61));
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "failed", result: { reason: "not_set_up" } });
    expect((await readCheck(env.DB, userId, "bedrock"))!.nextTryAt).toBeUndefined();
  });

  it("retries 'still switching this on' every 15 minutes and ticks the item when a call passes", async () => {
    const { world, plugins } = awsWorld();
    world.stack = true;
    world.converse = () => Response.json({ message: "Marketplace Agreement Pending" }, { status: 403, headers: { "x-amzn-ErrorType": "AccessDeniedException:http://internal.amazon.com/" } });
    await connectBedrock(plugins);
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({
      state: "switching_on", nextTryAt: at(15).toISOString(),
      result: { verdict: "switching_on", reason: "switching_on", reply: { status: 403, errorName: "AccessDeniedException", message: "Marketplace Agreement Pending" } },
    });
    expect(await runDueChecks(env.DB, plugins, at(14))).toBe(0);
    world.converse = () => Response.json({ output: { message: { content: [{ text: "OK" }] } }, usage: { inputTokens: 38, outputTokens: 3 } });
    expect(await runDueChecks(env.DB, plugins, at(15))).toBe(1);
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "passed" });
    // Both calls reached the model, so both are in the ledger.
    expect((await ledger()).map((r) => r.status)).toEqual([403, 200]);
  });

  it("records a grant removed after a pass as revoked, for T49's alert, and a pass again clears it", async () => {
    const { world, plugins } = awsWorld();
    world.stack = true;
    await connectBedrock(plugins);
    world.stack = false;
    await runCheck(env.DB, plugins, userId, "bedrock", at(120));
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "revoked", revokedAt: at(120).toISOString(), result: { reason: "not_set_up" } });
    world.stack = true;
    await runCheck(env.DB, plugins, userId, "bedrock", at(125));
    const check = await readCheck(env.DB, userId, "bedrock");
    expect(check!.state).toBe("passed");
    expect(check!.revokedAt).toBeUndefined();
  });

  it("polls again for the new grant when the user connects again after a revocation", async () => {
    const { world, plugins } = awsWorld();
    world.stack = true;
    await connectBedrock(plugins);
    world.stack = false;
    await runCheck(env.DB, plugins, userId, "bedrock", at(120));
    await connectBedrock(plugins, at(130));
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "checking", nextTryAt: at(131).toISOString(), result: { reason: "not_set_up" } });
  });

  it("stores no credential and no token anywhere", async () => {
    const { world, plugins, sent } = awsWorld();
    world.stack = true;
    await connectBedrock(plugins);
    const dump = JSON.stringify(await dumpEveryTable());
    for (const secret of ["secret-ASIAAPP", "token-ASIAAPP", "secret-ASIAUSER", "token-ASIAUSER"]) expect(dump).not.toContain(secret);
    const webIdentity = new URLSearchParams(sent[0]!.body).get("WebIdentityToken")!;
    expect(dump).not.toContain(webIdentity);
    // The record holds the role ARN and the external ID, and nothing else.
    expect(Object.keys((await readConnection(env.DB, userId, "bedrock"))!).sort()).toEqual(["externalId", "roleArn"]);
  });

  it("uses the region the user chose", async () => {
    const { world, plugins, sent } = awsWorld();
    world.stack = true;
    await connectBedrock(plugins);
    expect(await chooseRegion(env.DB, plugins, userId, "bedrock", "us-east-1", at(2))).toBeUndefined();
    expect(sent.filter((s) => s.url.includes("bedrock-runtime")).at(-1)!.url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/us.amazon.nova-2-lite-v1%3A0/converse");
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ region: "us-east-1", regionSetBy: "user", state: "passed" });
    expect(await chooseRegion(env.DB, plugins, userId, "bedrock", "mars-1", at(3))).toMatch(/not offered at that region/);
  });

  it("runs before any budget is set, through the proxy: a kind with no price row raises price_missing", async () => {
    const { world, plugins } = awsWorld();
    world.stack = true;
    world.converse = () => Response.json({ output: { message: { content: [{ text: "OK" }] } }, usage: { inputTokens: 38, outputTokens: 3, cacheWriteInputTokens: 10 } });
    await connectBedrock(plugins);
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "passed" });
    const [row] = await ledger();
    expect(row).toMatchObject({ task: "test_call", status: 200 });
    expect(JSON.parse(row!.costed_conservatively as string)).toEqual({ cache_write_1h: 0.5 });
    const { results } = await env.DB.prepare("SELECT kind, detail FROM price_alerts").all<{ kind: string; detail: string }>();
    expect(results).toEqual([{ kind: "price_missing", detail: expect.stringContaining("Nova 2.0 Lite at Amazon Bedrock (global) has no list price for cache_write_1h") }]);
  });

  it("keeps a revoked connection revoked while the test call waits for a spent budget", async () => {
    const { world, plugins } = awsWorld();
    world.stack = true;
    await connectBedrock(plugins);
    world.stack = false;
    await runCheck(env.DB, plugins, userId, "bedrock", at(120));
    await setBudget(env.DB, userId, "bedrock", 0.000001, "typed", T0);
    await runCheck(env.DB, plugins, userId, "bedrock", at(125));
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "revoked", revokedAt: at(120).toISOString(), result: { reason: "budget_spent" } });
  });

  it("waits while the month's budget is spent, and while the model has no price", async () => {
    const { world, plugins } = awsWorld();
    world.stack = true;
    await connectBedrock(plugins);
    await setBudget(env.DB, userId, "bedrock", 0.000001, "typed", T0);
    await runCheck(env.DB, plugins, userId, "bedrock", at(5));
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "passed", result: { reason: "budget_spent" }, nextTryAt: "2026-12-01T00:00:00.000Z" });
    await env.DB.prepare("DELETE FROM provider_budgets").run();
    await env.DB.prepare("DELETE FROM price_rows").run();
    await runCheck(env.DB, plugins, userId, "bedrock", at(6));
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ result: { reason: "no_price" }, nextTryAt: at(21).toISOString() });
  });

  it("says plainly when the app's own side is not set up yet (before T10)", async () => {
    const plugins = { bedrock: bedrockPlugin({ APP_ORIGIN }) };
    await connectBedrock(plugins);
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({
      state: "failed", result: { reason: "app_not_configured", note: "Admin's one-time setup is missing AWS_APP_ROLE_ARN." },
    });
  });

  it("refuses a field the provider would not accept, storing nothing", async () => {
    const { plugins } = awsWorld();
    const outcome = await connectProvider(env.DB, plugins, { userId, provider: "bedrock", typed: { accountId: "12345" }, appOrigin: APP_ORIGIN, now: T0 });
    expect(outcome).toEqual({ problem: "An AWS account ID is 12 digits." });
    expect(await readConnection(env.DB, userId, "bedrock")).toBeUndefined();
  });
});

describe("Disconnect and Ask Admin for help", () => {
  it("disconnect removes the record and its check, and the proxy then refuses the provider at once", async () => {
    const { world, plugins } = awsWorld();
    world.stack = true;
    await connectBedrock(plugins);
    await setBudget(env.DB, userId, "bedrock", 30, "typed", T0);
    await disconnectProvider(env.DB, userId, "bedrock");
    expect(await readConnection(env.DB, userId, "bedrock")).toBeUndefined();
    expect(await readCheck(env.DB, userId, "bedrock")).toBeUndefined();
    const outcome = await callModel(env.DB, plugins, { userId, task: "fill", main: { provider: "bedrock", model: "Nova 2.0 Lite", location: "global", request: {} } }, () => at(1));
    expect(outcome).toMatchObject({ kind: "refused", reason: "not_connected" });
  });

  it("sends the item's name and the plain reason only, never the provider's reply", async () => {
    const { plugins } = awsWorld();
    await connectBedrock(plugins);
    expect(await askAdminForHelp(env.DB, plugins, userId, "bedrock", at(1))).toBe(true);
    const { results } = await env.DB.prepare("SELECT item, reason FROM help_requests").all();
    expect(results).toEqual([{ item: "Connect Amazon Bedrock", reason: "The connection isn't set up yet, or was removed." }]);
    expect(JSON.stringify(results)).not.toContain("sts:AssumeRole");
  });
});

describe("a real call that finds the grant gone", () => {
  it("is refused at once and records the connection as revoked", async () => {
    const plugin = testPlugin("bedrock", { refuseMint: true });
    await writeConnection(env.DB, userId, plugin, { account: "123456789012", region: "global" }, T0);
    await env.DB.prepare("INSERT INTO provider_checks (user_id, provider, state, passed_at) VALUES (?, 'bedrock', 'passed', ?)").bind(userId, T0.toISOString()).run();
    await setBudget(env.DB, userId, "bedrock", 30, "typed", T0);
    const outcome = await callModel(env.DB, { bedrock: plugin }, { userId, task: "fill", main: { provider: "bedrock", model: "Nova 2.0 Lite", location: "global", request: {} } }, () => at(5));
    expect(outcome).toMatchObject({ kind: "refused", reason: "credential_failed" });
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "revoked", revokedAt: at(5).toISOString() });
  });

  it("is recorded as revoked when the credential still mints but the call is refused as not set up (a Vertex AI grant or Foundry role removed)", async () => {
    const plugin = testPlugin("bedrock");
    await writeConnection(env.DB, userId, plugin, { account: "123456789012", region: "global" }, T0);
    await env.DB.prepare("INSERT INTO provider_checks (user_id, provider, state, passed_at) VALUES (?, 'bedrock', 'passed', ?)").bind(userId, T0.toISOString()).run();
    await setBudget(env.DB, userId, "bedrock", 30, "typed", T0);
    plugin.replies.push({ status: 403, body: {}, error: { name: "PERMISSION_DENIED", message: "Permission denied on resource project example-project-123." } });
    const outcome = await callModel(env.DB, { bedrock: plugin }, { userId, task: "fill", main: { provider: "bedrock", model: "Nova 2.0 Lite", location: "global", request: {} } }, () => at(5));
    expect(outcome).toMatchObject({ kind: "provider_error", status: 403 });
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "revoked", revokedAt: at(5).toISOString() });
  });

  it("is not called revoked when the call is refused for another reason", async () => {
    const plugin = testPlugin("bedrock");
    await writeConnection(env.DB, userId, plugin, { account: "123456789012", region: "global" }, T0);
    await env.DB.prepare("INSERT INTO provider_checks (user_id, provider, state, passed_at) VALUES (?, 'bedrock', 'passed', ?)").bind(userId, T0.toISOString()).run();
    await setBudget(env.DB, userId, "bedrock", 30, "typed", T0);
    plugin.replies.push({ status: 400, body: {}, error: { name: "ValidationException", message: "bad request" } });
    await callModel(env.DB, { bedrock: plugin }, { userId, task: "fill", main: { provider: "bedrock", model: "Nova 2.0 Lite", location: "global", request: {} } }, () => at(5));
    expect((await readCheck(env.DB, userId, "bedrock"))!.state).toBe("passed");
  });

  it("is not called revoked when minting fails for another reason", async () => {
    const plugin = testPlugin("bedrock", { failMint: true });
    await writeConnection(env.DB, userId, plugin, { account: "123456789012", region: "global" }, T0);
    await env.DB.prepare("INSERT INTO provider_checks (user_id, provider, state, passed_at) VALUES (?, 'bedrock', 'passed', ?)").bind(userId, T0.toISOString()).run();
    await setBudget(env.DB, userId, "bedrock", 30, "typed", T0);
    await callModel(env.DB, { bedrock: plugin }, { userId, task: "fill", main: { provider: "bedrock", model: "Nova 2.0 Lite", location: "global", request: {} } }, () => at(5));
    expect((await readCheck(env.DB, userId, "bedrock"))!.state).toBe("passed");
  });
});

describe("Connect Microsoft Foundry, through a signed Microsoft sign-in and then admin consent", () => {
  const TENANT = "11111111-2222-4333-8444-555555555555";
  const OTHER_TENANT = "99999999-8888-4777-8666-555555555555";
  const CLIENT = "00000000-0000-4000-8000-000000000001";
  const ENDPOINT = "https://example-resource.services.ai.azure.com";
  const t0 = T0.getTime() / 1000;
  let ms: Awaited<ReturnType<typeof fakeMicrosoft>>;
  beforeAll(async () => {
    ms = await fakeMicrosoft();
  });

  // Microsoft: the sign-in's code is redeemed for an ID token carrying the
  // nonce of the sign-in link (a personal account in its own directory unless
  // `idp` says otherwise); Foundry tokens are recorded by tenant.
  const world = () => {
    const w = { nonce: "", tenant: TENANT, idp: "live.com" as string | undefined, minted: [] as string[] };
    const { fetcher } = scriptedFetch([
      [/discovery\/v2\.0\/keys$/, () => Response.json(ms.keySet)],
      [/login\.microsoftonline\.com\/[0-9a-f-]+\/oauth2\/v2\.0\/token$/, async (s) => {
        if (new URLSearchParams(s.body).get("grant_type") === "authorization_code") {
          return Response.json({ id_token: await ms.idToken({ iss: `https://login.microsoftonline.com/${w.tenant}/v2.0`, aud: CLIENT, tid: w.tenant, idp: w.idp, nonce: w.nonce, iat: t0, nbf: t0, exp: t0 + 3600 }) });
        }
        w.minted.push(new URL(s.url).pathname.split("/")[1]!);
        return Response.json({ access_token: "entra-token", expires_in: 4500 });
      }],
      [/anthropic\/v1\/messages/, () => Response.json({ content: [{ type: "text", text: "OK" }], usage: { input_tokens: 14, output_tokens: 2 } })],
    ]);
    return { w, plugins: { foundry: foundryPlugin({ APP_ORIGIN, ISSUER_KEYS, ENTRA_CLIENT_ID: CLIENT, FOUNDRY_CREDENTIAL: "federated" }, fetcher, () => T0) } };
  };
  // Back from either Microsoft page: the pending fields alone say which.
  const back = (p: ReturnType<typeof world>["plugins"], q: Record<string, string>, now = at(1)) =>
    finishConsent(env.DB, p, { userId, provider: "foundry", returned: new URLSearchParams(q), appOrigin: APP_ORIGIN, now });
  const signIn = async (p: ReturnType<typeof world>["plugins"], w: ReturnType<typeof world>["w"]) => {
    const outcome = await connectProvider(env.DB, p, { userId, provider: "foundry", typed: { endpoint: ENDPOINT, tenantId: TENANT }, appOrigin: APP_ORIGIN, now: T0 });
    const link = new URL((outcome as { open: string }).open);
    expect(link.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
    w.nonce = link.searchParams.get("nonce")!;
    return link.searchParams.get("state")!;
  };
  const consentState = (outcome: unknown) => {
    const link = new URL((outcome as { open: string }).open);
    expect(link.pathname).toBe(`/${TENANT}/adminconsent`);
    return link.searchParams.get("state")!;
  };

  it("keeps the tenant of the signed sign-in, finishes consent in it, then runs the test call minting only there", async () => {
    const { w, plugins: p } = world();
    const state = await signIn(p, w);
    expect(await readConnection(env.DB, userId, "foundry")).toBeUndefined();
    const consent = consentState(await back(p, { code: "code-1", state }));
    expect(consent).not.toBe(state);
    expect(await readConnection(env.DB, userId, "foundry")).toBeUndefined();

    await back(p, { tenant: TENANT, admin_consent: "True", state: consent });
    expect(await readConnection(env.DB, userId, "foundry")).toEqual({ tenantId: TENANT, endpoint: ENDPOINT });
    expect(await readCheck(env.DB, userId, "foundry")).toMatchObject({ state: "passed", result: { modelId: "claude-haiku-5-5", reply: { status: 200, text: "OK" } } });
    expect(w.minted).toEqual([TENANT]);
  });

  it("refuses a consent callback forged to name another tenant, and stores nothing", async () => {
    const { w, plugins: p } = world();
    const consent = consentState(await back(p, { code: "code-1", state: await signIn(p, w) }));
    const forged = await back(p, { tenant: OTHER_TENANT, admin_consent: "True", state: consent });
    expect(forged).toMatchObject({ problem: expect.stringContaining("different organisation than the one you signed in with") });
    expect(await readConnection(env.DB, userId, "foundry")).toBeUndefined();
    expect(await readCheck(env.DB, userId, "foundry")).toMatchObject({ consentState: undefined, pendingFields: undefined });
    expect(w.minted).toEqual([]);
    // That consent state is spent: the right tenant on it is refused too.
    expect(await back(p, { tenant: TENANT, admin_consent: "True", state: consent })).toMatchObject({ problem: expect.stringContaining("not for this Connect") });
    expect(await readConnection(env.DB, userId, "foundry")).toBeUndefined();
  });

  it("refuses a consent callback that skips the sign-in, a foreign state, and a used one", async () => {
    const { w, plugins: p } = world();
    const state = await signIn(p, w);
    // The sign-in's state brought back as if from admin consent, naming any
    // tenant: the pending fields are the sign-in's, which has no code here.
    expect(await back(p, { tenant: OTHER_TENANT, admin_consent: "True", state })).toMatchObject({ problem: expect.stringContaining("without a sign-in") });
    expect(await readConnection(env.DB, userId, "foundry")).toBeUndefined();
    expect(w.minted).toEqual([]);

    const fresh = await signIn(p, w);
    expect(await back(p, { code: "c", state: "not-it" })).toMatchObject({ problem: expect.stringContaining("not for this Connect") });
    expect("open" in (await back(p, { code: "c", state: fresh }))).toBe(true);
    // Used once: the same sign-in answer again is refused.
    expect(await back(p, { code: "c", state: fresh })).toMatchObject({ problem: expect.stringContaining("not for this Connect") });
  });

  it("refuses a work or school sign-in at Connect, naming Bedrock and Vertex AI, and stores nothing", async () => {
    const { w, plugins: p } = world();
    w.idp = undefined;
    const outcome = await back(p, { code: "c", state: await signIn(p, w) });
    expect(outcome).toMatchObject({ problem: expect.stringMatching(/only with a personal Microsoft account.*work or school account, so nothing was saved\. Connect Amazon Bedrock or Google Vertex AI instead\./) });
    expect(await readConnection(env.DB, userId, "foundry")).toBeUndefined();
    expect(await readCheck(env.DB, userId, "foundry")).toMatchObject({ consentState: undefined, pendingFields: undefined });
    expect(w.minted).toEqual([]);
  });

  it("refuses a sign-in whose ID token carries another Connect's nonce, and stores nothing", async () => {
    const { w, plugins: p } = world();
    const state = await signIn(p, w);
    w.nonce = "a-nonce-from-another-sign-in";
    expect(await back(p, { code: "c", state })).toMatchObject({ problem: expect.stringContaining("not made for this Connect") });
    expect(await readConnection(env.DB, userId, "foundry")).toBeUndefined();
    expect(await readCheck(env.DB, userId, "foundry")).toMatchObject({ consentState: undefined, pendingFields: undefined });
  });

  it("is scoped to the signed-in user: another user's answer cannot finish this user's Connect", async () => {
    const { w, plugins: p } = world();
    const state = await signIn(p, w);
    const other = (await userFor("friend-sub")).id;
    expect(await finishConsent(env.DB, p, { userId: other, provider: "foundry", returned: new URLSearchParams({ code: "c", state }), appOrigin: APP_ORIGIN, now: at(1) })).toHaveProperty("problem");
    expect("open" in (await back(p, { code: "c", state }))).toBe(true);
  });
});

describe("Bedrock's own list and the models it no longer offers", () => {
  const listSaying = (byName: Record<string, ModelOffer>): BedrockOffer => ({ region: "us-east-1", readAt: "2026-11-26T14:44:00.000Z", byName });
  const converseUrls = (sent: Sent[]) => sent.filter((s) => s.url.includes("bedrock-runtime")).map((s) => decodeURIComponent(s.url));

  const verdicts: ModelOffer[] = [{ kind: "dropped", pricedAt: ["global"] }, { kind: "not_offered", reason: "priced by prompt length", pricedAt: ["us-east-1"] }];

  it("runs the Connect test call at the test model's built-in profile IDs when the list drops or refuses it", async () => {
    for (const verdict of verdicts) {
      const { world, plugins, sent } = awsWorld(listSaying({ [TEST_MODEL]: verdict }));
      world.stack = true;
      await connectBedrock(plugins);
      expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "passed", region: "global", result: { model: TEST_MODEL, modelId: "global.amazon.nova-2-lite-v1:0" } });
      expect(await chooseRegion(env.DB, plugins, userId, "bedrock", "us-east-1", at(1))).toBeUndefined();
      expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "passed", region: "us-east-1", result: { modelId: "us.amazon.nova-2-lite-v1:0" } });
      const page = await (await handleProviders(new Request(`${APP_ORIGIN}${PROVIDERS_PATH}?provider=bedrock&change=region`), { db: env.DB, plugins, userId, viewer: "owner", appOrigin: APP_ORIGIN, now: at(1) })).text();
      expect(page).toContain("us.amazon.nova-2-lite-v1:0 (US cross-Region from us-east-1)");
      expect(page).toContain(">US cross-Region from us-east-1</option>");
      expect(converseUrls(sent)).toEqual([
        "https://bedrock-runtime.us-east-1.amazonaws.com/model/global.amazon.nova-2-lite-v1:0/converse",
        "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.amazon.nova-2-lite-v1:0/converse",
      ]);
      await disconnectProvider(env.DB, userId, "bedrock");
    }
  });

  it("refuses the test model in the model list and in a task call when the list drops or refuses it, with its reason", async () => {
    const reasons = ["Bedrock's own model list marks it legacy, or no longer as a chat model", "priced by prompt length"];
    for (const [i, verdict] of verdicts.entries()) {
      const { world, plugins, sent } = awsWorld(listSaying({ [TEST_MODEL]: verdict }));
      world.stack = true;
      await connectBedrock(plugins);
      await setBudget(env.DB, userId, "bedrock", 30, "typed", T0);
      const before = converseUrls(sent).length;
      const added = await addModel(env.DB, plugins, { userId, provider: "bedrock", model: TEST_MODEL, now: T0 });
      expect(added).toMatchObject({ kind: "refused", reason: verdict.kind === "dropped" ? "not_offered" : "cannot_call" });
      expect(plugins.bedrock.connect.notCallableReason(TEST_MODEL)).toBe(reasons[i]);
      const outcome = await callModel(env.DB, plugins, { userId, task: "fill", main: { provider: "bedrock", model: TEST_MODEL, location: "global", request: {} } }, () => T0);
      expect(outcome).toMatchObject({ kind: "refused", reason: "not_callable", detail: `${TEST_MODEL} is not offered at Amazon Bedrock yet: ${reasons[i]}` });
      expect(converseUrls(sent)).toHaveLength(before);
      await disconnectProvider(env.DB, userId, "bedrock");
    }
  });

  it("refuses a model still offered, but no longer at its stored location, sending nothing to Bedrock", async () => {
    const inRegionOnly: ModelOffer = { kind: "callable", modelId: "anthropic.claude-haiku-5-5", locations: [{ location: "us-east-1", callId: "us.anthropic.claude-haiku-5-5", kind: "us" }] };
    const { world, plugins, sent } = awsWorld(listSaying({ "Claude Haiku 5.5": inRegionOnly }));
    world.stack = true;
    await writeSnapshot(env.DB, {
      takenAt: "2026-11-24T07:00:00Z",
      status: "good",
      results: [],
      rows: [
        price("bedrock", "Nova 2.0 Lite", "input", 0.1), price("bedrock", "Nova 2.0 Lite", "output", 0.5),
        price("bedrock", "Claude Haiku 5.5", "input", 1), price("bedrock", "Claude Haiku 5.5", "output", 5),
      ],
    });
    await connectBedrock(plugins);
    await setBudget(env.DB, userId, "bedrock", 30, "typed", T0);
    const before = converseUrls(sent).length;
    const outcome = await callModel(env.DB, plugins, { userId, task: "fill", main: { provider: "bedrock", model: "Claude Haiku 5.5", location: "global", request: {} } }, () => T0);
    expect(outcome).toMatchObject({ kind: "refused", reason: "not_callable", detail: "Amazon Bedrock does not offer Claude Haiku 5.5 at global any more" });
    expect(converseUrls(sent)).toHaveLength(before);
  });

  it("keeps an added model the list later marks LEGACY at its in-Region price, saying it is legacy, not unpriced", async () => {
    const { world, plugins, sent } = awsWorld(listSaying({ "DeepSeek v3.2": { kind: "dropped", pricedAt: ["us-east-1"] } }));
    world.stack = true;
    await writeSnapshot(env.DB, {
      takenAt: "2026-11-24T07:00:00Z",
      status: "good",
      results: [],
      rows: [
        price("bedrock", "Nova 2.0 Lite", "input", 0.1), price("bedrock", "Nova 2.0 Lite", "output", 0.5),
        price("bedrock", "DeepSeek v3.2", "input", 0.6, "regional"), price("bedrock", "DeepSeek v3.2", "output", 2.4, "regional"),
      ],
    });
    await env.DB.prepare("INSERT INTO user_models (user_id, provider, model, location, added_at) VALUES (?, 'bedrock', 'DeepSeek v3.2', 'us-east-1', ?)").bind(userId, T0.toISOString()).run();
    await connectBedrock(plugins);
    await setBudget(env.DB, userId, "bedrock", 30, "typed", T0);
    const before = converseUrls(sent).length;
    const page = await (await handleProviders(new Request(`${APP_ORIGIN}${PROVIDERS_PATH}?provider=bedrock`), { db: env.DB, plugins, userId, viewer: "owner", appOrigin: APP_ORIGIN, now: T0 })).text();
    const at = page.indexOf('data-model="DeepSeek v3.2"');
    const row = page.slice(at, page.indexOf("</li>", at));
    expect(row).toContain("$0.60 in · $2.40 out");
    expect(row).toContain("not offered yet: Bedrock&#39;s own model list marks it legacy, or no longer as a chat model");
    expect(row).not.toContain("no price yet");
    expect(await addModel(env.DB, plugins, { userId, provider: "bedrock", model: "DeepSeek v3.2", now: T0 })).toMatchObject({ kind: "refused", reason: "cannot_call", location: "us-east-1" });
    expect(converseUrls(sent)).toHaveLength(before);
  });

  it("refuses an added built-in model the list marks dropped with its reason, sending nothing to Bedrock", async () => {
    const { world, plugins, sent } = awsWorld(listSaying({ "Claude Haiku 5.5": { kind: "dropped", pricedAt: ["global"] } }));
    world.stack = true;
    await writeSnapshot(env.DB, {
      takenAt: "2026-11-24T07:00:00Z",
      status: "good",
      results: [],
      rows: [
        price("bedrock", "Nova 2.0 Lite", "input", 0.1), price("bedrock", "Nova 2.0 Lite", "output", 0.5),
        price("bedrock", "Claude Haiku 5.5", "input", 1), price("bedrock", "Claude Haiku 5.5", "output", 5),
      ],
    });
    await env.DB.prepare("INSERT INTO user_models (user_id, provider, model, location, added_at) VALUES (?, 'bedrock', 'Claude Haiku 5.5', 'global', ?)").bind(userId, T0.toISOString()).run();
    await connectBedrock(plugins);
    // The Connect test call skips the model it can no longer call.
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "passed", result: { model: TEST_MODEL } });
    await setBudget(env.DB, userId, "bedrock", 30, "typed", T0);
    const before = converseUrls(sent).length;
    const outcome = await callModel(env.DB, plugins, { userId, task: "fill", main: { provider: "bedrock", model: "Claude Haiku 5.5", location: "global", request: {} } }, () => T0);
    expect(outcome).toMatchObject({
      kind: "refused",
      reason: "not_callable",
      detail: "Claude Haiku 5.5 is not offered at Amazon Bedrock yet: Bedrock's own model list marks it legacy, or no longer as a chat model",
    });
    expect(converseUrls(sent)).toHaveLength(before);
  });
});

describe("the Connect test call's model", () => {
  const USE_CASE_FORM = "Model use case details have not been submitted for this account. Fill out the Anthropic use case details form before using the model. If you have already filled out the form, try again in 15 minutes.";
  const converseUrls = (sent: Sent[]) => sent.filter((s) => s.url.includes("bedrock-runtime")).map((s) => decodeURIComponent(s.url));
  const open = async (plugins: ReturnType<typeof awsWorld>["plugins"], path: string, now: Date, init: RequestInit = {}) =>
    handleProviders(new Request(`${APP_ORIGIN}${PROVIDERS_PATH}${path}`, init), { db: env.DB, plugins, userId, viewer: "owner", appOrigin: APP_ORIGIN, now });
  const press = (plugins: ReturnType<typeof awsWorld>["plugins"], path: string, now: Date, fields: Record<string, string> = {}) =>
    open(plugins, path, now, { method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded", origin: APP_ORIGIN } });
  const NOVA_GLOBAL = "https://bedrock-runtime.us-east-1.amazonaws.com/model/global.amazon.nova-2-lite-v1:0/converse";
  const NOVA_US = "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.amazon.nova-2-lite-v1:0/converse";

  // The owner's account, 2026-11-27: Claude Haiku 4.5 added first (its test
  // passed then), Nova 2.0 Lite added later. Haiku 4.5 now answers with
  // Anthropic's use-case form, and the check is recorded as failed on it.
  it("is always the provider's test model, never the model added first: Try again, the re-check and Set and test call Nova 2 Lite", async () => {
    const { world, plugins, sent } = awsWorld();
    world.stack = true;
    const ok = world.converse;
    world.converse = (s) =>
      s.url.includes("anthropic.claude-haiku-4-5")
        ? Response.json({ message: USE_CASE_FORM }, { status: 404, headers: { "x-amzn-ErrorType": "ResourceNotFoundException" } })
        : ok(s);
    await writeSnapshot(env.DB, {
      takenAt: "2026-11-24T07:00:00Z",
      status: "good",
      results: [],
      rows: [
        price("bedrock", "Nova 2.0 Lite", "input", 0.1), price("bedrock", "Nova 2.0 Lite", "output", 0.5),
        price("bedrock", "Claude Haiku 4.5", "input", 1), price("bedrock", "Claude Haiku 4.5", "output", 5),
      ],
    });
    await env.DB.prepare("INSERT INTO user_models (user_id, provider, model, location, added_at) VALUES (?, 'bedrock', 'Claude Haiku 4.5', 'global', '2026-11-26T19:51:30Z')").bind(userId).run();
    await env.DB.prepare("INSERT INTO user_models (user_id, provider, model, location, added_at) VALUES (?, 'bedrock', 'Nova 2.0 Lite', 'global', '2026-11-27T03:19:45Z')").bind(userId).run();
    await connectBedrock(plugins);
    // The row as it stands live: failed on Claude Haiku 4.5.
    const stale = {
      at: T0.toISOString(), verdict: "failed", reason: "no_such_model", model: "Claude Haiku 4.5", modelId: "global.anthropic.claude-haiku-4-5-20251001-v1:0", location: "global",
      reply: { status: 404, errorName: "ResourceNotFoundException", message: USE_CASE_FORM },
    };
    await env.DB.prepare("UPDATE provider_checks SET state = 'failed', next_try_at = NULL, passed_at = NULL, result = ? WHERE user_id = ? AND provider = 'bedrock'").bind(JSON.stringify(stale), userId).run();
    sent.length = 0;

    // The region picker is labelled for the test model, not the stale result's.
    const picker = await (await open(plugins, "?provider=bedrock&change=region", at(1))).text();
    expect(picker).toContain(`<strong>Region</strong> for ${TEST_MODEL}</label>`);
    expect(picker).not.toContain("<strong>Region</strong> for Claude Haiku 4.5");

    // Try again.
    expect((await press(plugins, "/bedrock/retry", at(1))).status).toBe(303);
    expect(converseUrls(sent)).toEqual([NOVA_GLOBAL]);
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "passed", result: { model: TEST_MODEL, modelId: "global.amazon.nova-2-lite-v1:0" } });

    // The every-minute re-check, once due.
    await env.DB.prepare("UPDATE provider_checks SET next_try_at = ? WHERE user_id = ? AND provider = 'bedrock'").bind(at(2).toISOString(), userId).run();
    expect(await runDueChecks(env.DB, plugins, at(2))).toBe(1);
    expect(converseUrls(sent)).toEqual([NOVA_GLOBAL, NOVA_GLOBAL]);

    // Set and test.
    expect((await press(plugins, "/bedrock/region", at(3), { region: "us-east-1" })).status).toBe(303);
    expect(converseUrls(sent)).toEqual([NOVA_GLOBAL, NOVA_GLOBAL, NOVA_US]);
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "passed", region: "us-east-1", regionSetBy: "user", result: { model: TEST_MODEL, modelId: "us.amazon.nova-2-lite-v1:0" } });
    const after = await (await open(plugins, "?provider=bedrock&change=region", at(3))).text();
    expect(after).toContain(`<strong>Region</strong> for ${TEST_MODEL}</label>`);
    expect(after).toContain('<option value="us-east-1" selected>US cross-Region from us-east-1</option>');
    expect(converseUrls(sent).some((u) => u.includes("claude-haiku-4-5"))).toBe(false);
  });
});

describe("Refresh model list", () => {
  const HAIKU_45 = "anthropic.claude-haiku-4-5-20251001-v1:0";
  const chat = (modelId: string, modelName: string, providerName: string) => ({
    modelId, modelName, providerName, inputModalities: ["TEXT"], outputModalities: ["TEXT"], inferenceTypesSupported: ["INFERENCE_PROFILE"], lifecycle: "ACTIVE",
  });
  const catalog = (readAt: string): BedrockCatalog => ({
    region: "us-east-1",
    readAt,
    models: [chat("amazon.nova-2-lite-v1:0", "Nova 2.0 Lite", "Amazon"), chat(HAIKU_45, "Claude Haiku 4.5", "Anthropic")],
    profiles: [
      { id: "global.amazon.nova-2-lite-v1:0", models: [{ region: "", modelId: "amazon.nova-2-lite-v1:0" }] },
      { id: `global.${HAIKU_45}`, models: [{ region: "", modelId: HAIKU_45 }] },
    ],
  });
  const controlPlane = (sent: Sent[]) => sent.filter((s) => s.url.startsWith("https://bedrock.us-east-1.amazonaws.com/")).map((s) => decodeURIComponent(new URL(s.url).pathname));
  const open = (plugins: ReturnType<typeof awsWorld>["plugins"], now: Date, readCatalog?: (now: Date) => Promise<CatalogRead>, init: RequestInit = {}, path = "?provider=bedrock") =>
    handleProviders(new Request(`${APP_ORIGIN}${PROVIDERS_PATH}${path}`, init), { db: env.DB, plugins, userId, viewer: "owner", appOrigin: APP_ORIGIN, now, readCatalog });
  const refresh = (plugins: ReturnType<typeof awsWorld>["plugins"], now: Date, readCatalog?: (now: Date) => Promise<CatalogRead>) =>
    open(plugins, now, readCatalog, { method: "POST", body: new URLSearchParams(), headers: { "content-type": "application/x-www-form-urlencoded", origin: APP_ORIGIN } }, "/bedrock/refresh");
  const entry = (page: string, model: string) => page.slice(page.indexOf(`data-model="${model}"`), page.indexOf("</li>", page.indexOf(`data-model="${model}"`)));

  // The list the daily refresh read, and the plug-in built from it as each request builds it.
  async function listed(template: string) {
    await writeSnapshot(env.DB, {
      takenAt: "2026-11-25T06:00:00Z",
      status: "good",
      results: [],
      rows: [
        price("bedrock", "Nova 2.0 Lite", "input", 0.1), price("bedrock", "Nova 2.0 Lite", "output", 0.5),
        price("bedrock", "Claude Haiku 4.5", "input", 1), price("bedrock", "Claude Haiku 4.5", "output", 5),
      ],
      bedrockCatalog: catalog("2026-11-25T06:00:00.000Z"),
    });
    const aws = awsWorld((await readBedrockOffer(env.DB, "us-east-1"))!);
    aws.world.stack = true;
    aws.world.template = template;
    await connectBedrock(aws.plugins);
    aws.sent.length = 0;
    return aws;
  }

  it("reads the list again with the app's role, then the account's terms and form with the user's role, and notes them on each entry without blocking a pick", async () => {
    const { world, plugins, sent } = await listed("1.2.0");
    world.availability = (id) =>
      Response.json({ agreementAvailability: { status: id === HAIKU_45 ? "NOT_AVAILABLE" : "AVAILABLE" }, authorizationStatus: "AUTHORIZED", entitlementAvailability: "AVAILABLE", regionAvailability: "AVAILABLE" });
    const reads: Date[] = [];
    const readCatalog = async (now: Date): Promise<CatalogRead> => {
      reads.push(now);
      return { ok: true, catalog: catalog(now.toISOString()) };
    };
    const response = await refresh(plugins, at(1), readCatalog);
    expect(response.status).toBe(303);
    expect(reads).toEqual([at(1)]);
    // Only the Marketplace-sold model is read; Nova is AWS's own.
    expect(controlPlane(sent)).toEqual(["/use-case-for-model-access", `/foundation-model-availability/${HAIKU_45}`]);
    expect(await readAccountCheck(env.DB, userId)).toMatchObject({
      checkedAt: at(1).toISOString(), form: "not_filled",
      models: { "Claude Haiku 4.5": { agreement: "NOT_AVAILABLE", authorization: "AUTHORIZED", entitlement: "AVAILABLE", region: "AVAILABLE" } },
    });

    const page = await (await open(plugins, at(1))).text();
    expect(page).toContain("<button type=\"submit\" class=\"btn small ghost\">Refresh model list</button>");
    expect(page).toContain("Bedrock's model list read 10:01 UTC on 2026&#8209;11&#8209;25 · your AWS account checked 10:01 UTC.");
    const haiku = entry(page, "Claude Haiku 4.5");
    expect(haiku).toContain("accept terms on first pick · needs Anthropic&#39;s form");
    expect(haiku).not.toContain("aria-disabled");
    expect(entry(page, TEST_MODEL)).not.toContain("lb-notes");
    expect(page).not.toContain("Update the stack for live account checks");

    // A minute between refreshes, per user.
    const again = await refresh(plugins, at(1.5), readCatalog);
    expect(again.status).toBe(429);
    expect(await again.text()).toContain("The list was refreshed at 10:01 UTC; refresh it again from 10:02 UTC.");
    expect(reads).toHaveLength(1);
    expect(controlPlane(sent)).toHaveLength(2);
    expect((await refresh(plugins, at(2), readCatalog)).status).toBe(303);
  });

  it("marks each model's state unknown on a stack older than 1.2.0, with the update to make, and reads nothing in the account", async () => {
    const { plugins, sent } = await listed("1.1.0");
    expect((await refresh(plugins, at(1), async (now) => ({ ok: true, catalog: catalog(now.toISOString()) }))).status).toBe(303);
    expect(controlPlane(sent)).toEqual([]);
    const page = await (await open(plugins, at(1))).text();
    expect(page).toContain("Update the stack for live account checks: in AWS CloudFormation, select the “chief-of-staff” stack, choose Update, then Replace existing template with the app&#39;s template 1.2.0");
    expect(entry(page, "Claude Haiku 4.5")).toContain("account state unknown");
    expect(entry(page, "Claude Haiku 4.5")).not.toContain("aria-disabled");
  });

  it("says the role was refused the reads, as for an older stack, when the stack's version is not known", async () => {
    const { world, plugins } = await listed("1.2.0");
    world.useCase = () => Response.json({ message: "not authorized to perform: bedrock:GetUseCaseForModelAccess" }, { status: 403, headers: { "x-amzn-ErrorType": "AccessDeniedException" } });
    await refresh(plugins, at(1));
    expect(await readAccountCheck(env.DB, userId)).toMatchObject({ form: "unknown", models: { "Claude Haiku 4.5": "unknown" } });
    expect((await readAccountCheck(env.DB, userId))!.note).toMatch(/^Update the stack for live account checks/);
  });

  it("keeps the list it has when Bedrock's list cannot be read again, and still checks the account", async () => {
    const { world, plugins, sent } = await listed("1.2.0");
    world.useCase = () => Response.json({ formData: "eyJjb21wYW55TmFtZSI6Im1lIn0=" });
    await refresh(plugins, at(1), async () => ({ ok: false, error: "ListFoundationModels answered 403 AccessDeniedException" }));
    const page = await (await open(plugins, at(1))).text();
    expect(page).toContain("Bedrock&#39;s model list could not be read again (ListFoundationModels answered 403 AccessDeniedException); the list read 06:00 UTC on 2026-11-25 stays in use.");
    expect(page).toContain("Bedrock's model list read 06:00 UTC");
    expect(entry(page, "Claude Haiku 4.5")).not.toContain("needs Anthropic");
    expect(controlPlane(sent)).toHaveLength(2);
  });

  it("forgets the account's states on Disconnect", async () => {
    const { plugins } = await listed("1.2.0");
    await refresh(plugins, at(1));
    expect(await readAccountCheck(env.DB, userId)).toBeDefined();
    await open(plugins, at(2), undefined, { method: "POST", body: new URLSearchParams(), headers: { "content-type": "application/x-www-form-urlencoded", origin: APP_ORIGIN } }, "/bedrock/disconnect");
    expect(await readAccountCheck(env.DB, userId)).toBeUndefined();
  });
});
