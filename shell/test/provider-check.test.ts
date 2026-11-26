import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addModel } from "../src/models/add";
import { ADD_MODEL_PATH, PROVIDERS_PATH } from "../src/paths";
import { handleAddModel } from "../src/models/page";
import { handleProviders } from "../src/providers/page";
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
  const world = { stack: false, converse: (): Response => Response.json({ output: { message: { content: [{ text: "OK" }] } }, usage: { inputTokens: 38, outputTokens: 3 } }) };
  const { fetcher, sent } = scriptedFetch([
    [/sts\.us-east-1/, (s: Sent) => {
      const action = new URLSearchParams(s.body).get("Action");
      if (action === "AssumeRoleWithWebIdentity") return stsCredentials(action, "ASIAAPP");
      return world.stack ? stsCredentials("AssumeRole", "ASIAUSER") : stsError("AccessDenied", "User: arn:aws:sts::111122223333:assumed-role/chief-of-staff-app/chief-of-staff is not authorized to perform: sts:AssumeRole");
    }],
    [/bedrock-runtime/, () => world.converse()],
    [/cloudformation/, () => new Response("<Outputs><member><OutputKey>TemplateVersion</OutputKey><OutputValue>1.0.0</OutputValue></member></Outputs>")],
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

  it("refuses the test model on Add a model and in a task call when the list drops or refuses it, with its reason", async () => {
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
    const page = await (await handleAddModel(new Request(`${APP_ORIGIN}${ADD_MODEL_PATH}?provider=bedrock`), { db: env.DB, plugins, userId, viewer: "owner", now: T0 })).text();
    const row = page.slice(page.indexOf("<strong>DeepSeek v3.2</strong>"), page.indexOf("</tr>", page.indexOf("<strong>DeepSeek v3.2</strong>")));
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
