import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { askAdminForHelp, chooseRegion, connectProvider, disconnectProvider, finishConsent, readCheck, runCheck, runDueChecks } from "../src/providers/check";
import { bedrockPlugin } from "../src/providers/bedrock";
import { foundryPlugin } from "../src/providers/foundry";
import { writeSnapshot } from "../src/prices/store";
import type { PriceRow } from "../src/prices/types";
import { setBudget } from "../src/proxy/budgets";
import { readConnection, writeConnection } from "../src/proxy/connections";
import { callModel } from "../src/proxy/proxy";
import { APP_ORIGIN, issuerKey, issuerKeys, scriptedFetch, stsCredentials, stsError, type Sent } from "./issuer-fixture";
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
      price("bedrock", "Claude Haiku 5.5", "input", 0.1),
      price("bedrock", "Claude Haiku 5.5", "output", 0.5),
      price("bedrock", "Claude Haiku 5.5", "input", 0.11, "cross-region"),
      price("bedrock", "Claude Haiku 5.5", "output", 0.55, "cross-region"),
      { ...price("foundry", "Claude Haiku 5.5", "input", 0.1), region: "global", source: "maintainer-read" },
      { ...price("foundry", "Claude Haiku 5.5", "output", 0.5), region: "global", source: "maintainer-read" },
    ],
  });
});

// AWS as the scenario has it: whether the user's stack exists, and what Converse says.
function awsWorld() {
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
    bedrock: bedrockPlugin({ APP_ORIGIN, ISSUER_KEYS, AWS_APP_ROLE_ARN: "arn:aws:iam::111122223333:role/chief-of-staff-app", BEDROCK_TEMPLATE_URL: "https://t.example/v1.0.0.json" }, fetcher, () => T0),
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
      verdict: "failed", reason: "not_set_up", model: "Claude Haiku 5.5", modelId: "global.anthropic.claude-haiku-5-5",
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
    expect(rows[0]).toMatchObject({ task: "test_call", provider: "bedrock", model: "Claude Haiku 5.5", region: "global", status: 200, plugin_version: "bedrock-1.0.0", input_tokens: 38, output_tokens: 3, fallback: 0 });
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
    expect(await chooseRegion(env.DB, plugins, userId, "bedrock", "cross-region", at(2))).toBeUndefined();
    expect(sent.filter((s) => s.url.includes("bedrock-runtime")).at(-1)!.url).toContain("/model/us.anthropic.claude-haiku-5-5/converse");
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ region: "cross-region", regionSetBy: "user", state: "passed" });
    expect(await chooseRegion(env.DB, plugins, userId, "bedrock", "mars-1", at(3))).toMatch(/not offered at that region/);
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
    const outcome = await callModel(env.DB, plugins, { userId, task: "fill", main: { provider: "bedrock", model: "Claude Haiku 5.5", location: "global", request: {} } }, () => at(1));
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
    const outcome = await callModel(env.DB, { bedrock: plugin }, { userId, task: "fill", main: { provider: "bedrock", model: "Claude Haiku 5.5", location: "global", request: {} } }, () => at(5));
    expect(outcome).toMatchObject({ kind: "refused", reason: "credential_failed" });
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "revoked", revokedAt: at(5).toISOString() });
  });

  it("is not called revoked when minting fails for another reason", async () => {
    const plugin = testPlugin("bedrock", { failMint: true });
    await writeConnection(env.DB, userId, plugin, { account: "123456789012", region: "global" }, T0);
    await env.DB.prepare("INSERT INTO provider_checks (user_id, provider, state, passed_at) VALUES (?, 'bedrock', 'passed', ?)").bind(userId, T0.toISOString()).run();
    await setBudget(env.DB, userId, "bedrock", 30, "typed", T0);
    await callModel(env.DB, { bedrock: plugin }, { userId, task: "fill", main: { provider: "bedrock", model: "Claude Haiku 5.5", location: "global", request: {} } }, () => at(5));
    expect((await readCheck(env.DB, userId, "bedrock"))!.state).toBe("passed");
  });
});

describe("Connect Microsoft Foundry, through admin consent", () => {
  const TENANT = "11111111-2222-4333-8444-555555555555";
  const plugins = () => {
    const { fetcher } = scriptedFetch([
      [/login\.microsoftonline\.com/, () => Response.json({ access_token: "entra-token", expires_in: 4500 })],
      [/anthropic\/v1\/messages/, () => Response.json({ content: [{ type: "text", text: "OK" }], usage: { input_tokens: 14, output_tokens: 2 } })],
    ]);
    return { foundry: foundryPlugin({ APP_ORIGIN, ISSUER_KEYS, ENTRA_CLIENT_ID: "client-1", FOUNDRY_CREDENTIAL: "federated" }, fetcher, () => T0) };
  };

  it("stores the tenant only when Microsoft returns this Connect's state, then runs the test call", async () => {
    const p = plugins();
    const outcome = await connectProvider(env.DB, p, { userId, provider: "foundry", typed: { endpoint: "https://example-resource.services.ai.azure.com" }, appOrigin: APP_ORIGIN, now: T0 });
    const state = new URL((outcome as { open: string }).open).searchParams.get("state")!;
    expect(await readConnection(env.DB, userId, "foundry")).toBeUndefined();

    const forged = await finishConsent(env.DB, p, { userId, provider: "foundry", returned: new URLSearchParams({ tenant: TENANT, admin_consent: "True", state: "not-it" }), now: at(1) });
    expect(forged).toMatchObject({ problem: expect.stringContaining("not for this Connect") });
    expect(await readConnection(env.DB, userId, "foundry")).toBeUndefined();

    await finishConsent(env.DB, p, { userId, provider: "foundry", returned: new URLSearchParams({ tenant: TENANT, admin_consent: "True", state }), now: at(1) });
    expect(await readConnection(env.DB, userId, "foundry")).toEqual({ tenantId: TENANT, endpoint: "https://example-resource.services.ai.azure.com" });
    expect(await readCheck(env.DB, userId, "foundry")).toMatchObject({ state: "passed", result: { modelId: "claude-haiku-5-5", reply: { status: 200, text: "OK" } } });
    // The state is used once.
    expect(await finishConsent(env.DB, p, { userId, provider: "foundry", returned: new URLSearchParams({ tenant: TENANT, admin_consent: "True", state }), now: at(2) })).toHaveProperty("problem");
  });
});
