import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addModel, listOffer, namesPickedModel, readUserModels } from "../src/models/add";
import { handleAddModel } from "../src/models/page";
import { ADD_MODEL_PATH } from "../src/paths";
import { pickedModels, setBudget } from "../src/proxy/budgets";
import { foundryPlugin, usageFromChatCompletions } from "../src/providers/foundry";
import { geminiModelId, usageFromGemini, vertexPlugin } from "../src/providers/vertex";
import { writeSnapshot } from "../src/prices/store";
import type { PriceRow, Provider } from "../src/prices/types";
import { writeConnection } from "../src/proxy/connections";
import type { PluginRegistry } from "../src/proxy/plugin";
import { callModel } from "../src/proxy/proxy";
import { runCheck } from "../src/providers/check";
import type { Viewer } from "../src/providers/page";
import { APP_ORIGIN, issuerKey, issuerKeys, scriptedFetch, type Sent } from "./issuer-fixture";
import { ok, testPlugin, userFor, type TestPlugin } from "./test-plugin";

const NOW = new Date("2026-11-25T10:00:00Z");
const TENANT = "11111111-2222-4333-8444-555555555555";
const ENDPOINT = "https://example-resource.services.ai.azure.com";

const row = (provider: Provider, model: string, tokenKind: PriceRow["tokenKind"], usdPerMTok: number, source: PriceRow["source"] = "maintainer-read"): PriceRow => ({
  provider, model, deployment: "global", region: "global", tokenKind, longPrompt: false, batch: false, usdPerMTok,
  source, dateRead: "2026-11-24", stale: false, disagreement: false,
});

const seed = () =>
  writeSnapshot(env.DB, {
    takenAt: "2026-11-24T06:00:00Z",
    status: "good",
    results: [],
    rows: [
      row("bedrock", "test-sonnet", "input", 2, "aws-price-list"),
      row("bedrock", "test-sonnet", "output", 10, "aws-price-list"),
      row("bedrock", "test-haiku", "input", 0.25, "aws-price-list"),
      row("bedrock", "test-haiku", "output", 1.25, "aws-price-list"),
      // Only an input price: not a listed price the budget stop can use.
      row("bedrock", "test-half-priced", "input", 1, "aws-price-list"),
      row("foundry", "Claude Sonnet 5.5", "input", 3),
      row("foundry", "Claude Sonnet 5.5", "output", 15),
      row("foundry", "Claude Opus 5", "input", 5),
      row("foundry", "Claude Opus 5", "output", 25),
      row("foundry", "Claude Opus 5.5", "input", 5),
      row("foundry", "Claude Opus 5.5", "output", 25),
      row("foundry", "GPT-6-luna", "input", 1.25, "azure-retail"),
      row("foundry", "GPT-6-luna", "output", 10, "azure-retail"),
      row("foundry", "GPT 5.1", "input", 1.25, "azure-retail"),
      row("foundry", "GPT 5.1", "output", 10, "azure-retail"),
      row("foundry", "DeepSeek V3.2 (Fireworks)", "input", 0.56, "azure-retail"),
      row("foundry", "DeepSeek V3.2 (Fireworks)", "output", 1.68, "azure-retail"),
      { ...row("vertex", "Gemini 3.5 Flash", "input", 0.3, "google-catalog"), deployment: "regional", region: "us" },
      { ...row("vertex", "Gemini 3.5 Flash", "output", 2.5, "google-catalog"), deployment: "regional", region: "us" },
    ],
  });

let userId: string;
let plugin: TestPlugin;
let plugins: PluginRegistry;

const connect = (uid: string, p = plugin) => writeConnection(env.DB, uid, p, { account: "123456789012", region: "global" }, NOW);

beforeEach(async () => {
  await seed();
  userId = (await userFor("add-sub")).id;
  plugin = testPlugin("bedrock");
  plugin.connect.knownModels = ["test-not-yet-priced"];
  plugins = { bedrock: plugin };
  await connect(userId);
});

const ledger = async (uid: string) =>
  (await env.DB.prepare("SELECT task, model, status FROM model_calls WHERE user_id = ?").bind(uid).all<{ task: string; model: string; status: number }>()).results;

const request = (path: string, init: RequestInit = {}) => new Request(`${APP_ORIGIN}${ADD_MODEL_PATH}${path}`, init);
const open = (regs: PluginRegistry, path = "", uid = userId, viewer: Viewer = "owner") => handleAddModel(request(path), { db: env.DB, plugins: regs, userId: uid, viewer, now: NOW });
const pick = (regs: PluginRegistry, provider: string, fields: Record<string, string>, uid = userId, viewer: Viewer = "owner", verb = "pick") =>
  handleAddModel(
    request(`/${provider}/${verb}`, { method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded", origin: APP_ORIGIN } }),
    { db: env.DB, plugins: regs, userId: uid, viewer, now: NOW },
  );

describe("Add a model: the list", () => {
  it("lists every model the table prices at the provider, with its price, source, date read and the tier from that price, and nothing to type", async () => {
    const rows = await listOffer(env.DB, plugins, userId, "bedrock");
    expect(rows.map((r) => r.model)).toEqual(["test-haiku", "test-half-priced", "test-not-yet-priced", "test-sonnet"]);
    const sonnet = rows.find((r) => r.model === "test-sonnet")!;
    expect(sonnet).toMatchObject({ location: "global", locationSetBy: "app", tier: "Middle", callable: true, price: { input: 2, output: 10, source: "aws-price-list", dateRead: "2026-11-24" } });
    expect(rows.find((r) => r.model === "test-haiku")!.tier).toBe("Smallest");

    const page = await (await open(plugins)).text();
    expect(page).toContain("<strong>test-sonnet</strong>");
    expect(page).toContain("$2.00 in · $10.00 out");
    expect(page).toContain(">Middle<");
    expect(page).toContain("AWS price-list files, offers AmazonBedrockFoundationModels and AmazonBedrock");
    expect(page).toContain("read 2026&#8209;11&#8209;24");
    expect(page).toContain("global, chosen by the app");
    // Nothing to type on a provider that names the model itself.
    expect(page).not.toContain('name="deployment"');
    expect(page).not.toMatch(/design only|example row|placeholder/i);
  });

  it("shows a model with no price as \"no price yet\", which cannot be picked", async () => {
    const page = await (await open(plugins)).text();
    for (const model of ["test-not-yet-priced", "test-half-priced"]) {
      const at = page.indexOf(`<strong>${model}</strong>`);
      const tr = page.slice(at, page.indexOf("</tr>", at));
      expect(tr).toContain("no price yet");
      expect(tr).toContain("Cannot be picked");
      expect(tr).not.toContain('type="submit"');
    }
  });

  it("asks a user with no provider connected to connect one first", async () => {
    const other = (await userFor("nobody")).id;
    const page = await (await open(plugins, "", other)).text();
    expect(page).toContain("Connect a provider first");
    expect(page).not.toContain("<table");
  });
});

describe("Add a model: what the plug-in knows of each model", () => {
  it("says why each model it cannot call is not offered, in its own words", async () => {
    plugin.connect.canCall = (m) => m !== "test-haiku";
    plugin.connect.notCallableReason = (m) => `no ID for ${m}`;
    const page = await (await open(plugins)).text();
    const at = page.indexOf("<strong>test-haiku</strong>");
    expect(page.slice(at, page.indexOf("</tr>", at))).toContain("not offered yet: no ID for test-haiku");
    const refused = await pick(plugins, "bedrock", { model: "test-haiku" });
    expect(await refused.text()).toContain("test-haiku is not offered at Test bedrock yet: no ID for test-haiku.");
    expect(plugin.calls).toHaveLength(0);
  });

  it("marks a model known to make no tool call, and it can still be picked", async () => {
    plugin.connect.noToolUse = (m) => (m === "test-haiku" ? "tested live on Test Haiku (test.haiku-1): no tool call" : undefined);
    const rows = await listOffer(env.DB, plugins, userId, "bedrock");
    expect(rows.find((r) => r.model === "test-haiku")).toMatchObject({ noToolUse: "tested live on Test Haiku (test.haiku-1): no tool call", callable: true });
    const page = await (await open(plugins)).text();
    const at = page.indexOf("<strong>test-haiku</strong>");
    const tr = page.slice(at, page.indexOf("</tr>", at));
    expect(tr).toContain('<span class="pill warn" title="tested live on Test Haiku (test.haiku-1): no tool call">no tool use</span>');
    expect(tr).toContain("tested live on Test Haiku (test.haiku-1): no tool call; for tasks that need no tools");
    expect(tr).toContain('type="submit"');
    const sonnet = page.indexOf("<strong>test-sonnet</strong>");
    expect(page.slice(sonnet, page.indexOf("</tr>", sonnet))).not.toContain("no tool use");
  });

  it("leaves out a model the provider no longer offers, unless the user added it", async () => {
    plugin.replies.push(ok({ input: 1, output: 1 }));
    expect((await addModel(env.DB, plugins, { userId, provider: "bedrock", model: "test-haiku", now: NOW })).kind).toBe("added");
    plugin.connect.listed = (m) => m !== "test-haiku" && m !== "test-sonnet";
    expect((await listOffer(env.DB, plugins, userId, "bedrock")).map((r) => r.model)).toEqual(["test-haiku", "test-half-priced", "test-not-yet-priced"]);
    expect((await pick(plugins, "bedrock", { model: "test-sonnet" })).status).toBe(400);
  });
});

describe("Add a model: picking", () => {
  it("runs the test call by itself through the proxy and adds the model only when it passes", async () => {
    plugin.replies.push(ok({ input: 40, output: 2 }, { model: "test-sonnet-20261101", text: "OK" }));
    const response = await pick(plugins, "bedrock", { model: "test-sonnet" });
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("<strong>test-sonnet added.</strong> Its test call ran by itself and passed.");
    expect(page).toContain("bedrock replied: 200 OK · test-sonnet (global) · reply names test-sonnet-20261101 · “OK”");
    expect(page).toContain("40 input and 2 output tokens · $0.0001");
    expect(plugin.calls).toHaveLength(1);
    expect(await ledger(userId)).toEqual([{ task: "test_call", model: "test-sonnet", status: 200 }]);

    const [added] = await readUserModels(env.DB, userId);
    expect(added).toMatchObject({ provider: "bedrock", model: "test-sonnet", location: "global", test: { status: 200, repliedModel: "test-sonnet-20261101", costUsd: 0.0001, usage: { input: 40, output: 2 } } });
    // The budget suggestion reads the same rows.
    expect((await pickedModels(env.DB, userId, "bedrock")).map((m) => m.model)).toEqual(["test-sonnet"]);
    expect(await (await open(plugins)).text()).toMatch(/<span class="pill ok">added<\/span> <button type="submit" class="btn small">Test again<\/button>/);
  });

  it("refuses a reply naming a different model than the one picked, with a plain reason, and adds nothing", async () => {
    plugin.replies.push(ok({ input: 40, output: 2 }, { model: "test-haiku" }));
    const response = await pick(plugins, "bedrock", { model: "test-sonnet" });
    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).toContain("bedrock&#39;s reply names another model (test-haiku), not test-sonnet, so test-sonnet was not added.");
    expect(page).toContain("bedrock replied: 200 OK · model test-haiku");
    expect(await readUserModels(env.DB, userId)).toEqual([]);
  });

  it("refuses a model with no price yet without calling the provider, and the proxy refuses a direct call to it", async () => {
    const response = await pick(plugins, "bedrock", { model: "test-not-yet-priced" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("test-not-yet-priced has no price yet, so it cannot be added: the budget stop needs a real price.");
    expect(plugin.calls).toHaveLength(0);
    expect(await readUserModels(env.DB, userId)).toEqual([]);

    await setBudget(env.DB, userId, "bedrock", 50, "typed", NOW);
    const direct = await callModel(env.DB, plugins, { userId, task: "fill", main: { provider: "bedrock", model: "test-not-yet-priced", location: "global", request: {} } }, () => NOW);
    expect(direct).toMatchObject({ kind: "refused", reason: "no_price" });
    expect(plugin.calls).toHaveLength(0);
  });

  it("refuses a model not on the provider's list, and a provider the user has not connected", async () => {
    expect(await addModel(env.DB, plugins, { userId, provider: "bedrock", model: "made-up", now: NOW })).toMatchObject({ kind: "refused", reason: "not_offered" });
    const vertex = testPlugin("vertex");
    expect(await addModel(env.DB, { ...plugins, vertex }, { userId, provider: "vertex", model: "Gemini 3.5 Flash", now: NOW })).toMatchObject({ kind: "refused", reason: "not_connected" });
    expect(vertex.calls).toHaveLength(0);
  });

  it("shows a failed test call as its three lines and adds nothing", async () => {
    plugin.replies.push({ status: 403, body: {}, error: { name: "AccessDeniedException", message: "not authorized to invoke" } });
    const page = await (await pick(plugins, "bedrock", { model: "test-sonnet" })).text();
    expect(page).toContain("The connection isn&#39;t set up yet, or was removed.");
    expect(page).toContain("bedrock replied: 403 · AccessDeniedException · “not authorized to invoke”");
    expect(await readUserModels(env.DB, userId)).toEqual([]);
  });

  it("reads the stack's template version again before saying why a test call failed, so a stack just updated counts as updated", async () => {
    await env.DB.prepare("INSERT INTO provider_checks (user_id, provider, state, passed_at, template_version) VALUES (?, 'bedrock', 'passed', ?, '1.0.0')").bind(userId, NOW.toISOString()).run();
    plugin.connect.classify = (_f, _c, setupVersion) => ({ reason: "not_allowed_yet", fix: `classified on template ${setupVersion}`, links: [] });
    const stack = { version: "1.1.0" as string | Error };
    plugin.connect.readSetupVersion = async () => {
      if (stack.version instanceof Error) throw stack.version;
      return stack.version;
    };
    const failed = { status: 403, body: {}, error: { name: "AccessDeniedException", message: "is not available for this account" } };
    plugin.replies.push(failed);
    expect(await (await pick(plugins, "bedrock", { model: "test-sonnet" })).text()).toContain("classified on template 1.1.0");
    expect(await env.DB.prepare("SELECT template_version FROM provider_checks WHERE user_id = ?").bind(userId).first("template_version")).toBe("1.1.0");
    // A read that fails keeps the version last read.
    stack.version = new Error("DescribeStacks refused");
    plugin.replies.push(failed);
    expect(await (await pick(plugins, "bedrock", { model: "test-sonnet" })).text()).toContain("classified on template 1.1.0");
  });
});

describe("Add a model: each user's own", () => {
  it("stores the added models per user: another user sees none of them and adds their own", async () => {
    await pick(plugins, "bedrock", { model: "test-sonnet" });
    const other = (await userFor("other-sub")).id;
    await connect(other);
    expect(await readUserModels(env.DB, other)).toEqual([]);
    expect((await listOffer(env.DB, plugins, other, "bedrock")).some((r) => r.added)).toBe(false);
    expect(await (await open(plugins, "", other)).text()).not.toContain("pill ok");

    await pick(plugins, "bedrock", { model: "test-haiku" }, other);
    expect((await readUserModels(env.DB, userId)).map((m) => m.model)).toEqual(["test-sonnet"]);
    expect((await readUserModels(env.DB, other)).map((m) => m.model)).toEqual(["test-haiku"]);
    // Each test call is on its own user's ledger.
    expect((await ledger(other)).map((r) => r.model)).toEqual(["test-haiku"]);
  });

  it("keeps a model's first added date when it is tested again, so the daily check keeps calling the first model picked", async () => {
    await pick(plugins, "bedrock", { model: "test-haiku" });
    const later = new Date("2026-11-26T10:00:00Z");
    await addModel(env.DB, plugins, { userId, provider: "bedrock", model: "test-sonnet", now: later });
    const latest = new Date("2026-11-27T10:00:00Z");
    expect(await addModel(env.DB, plugins, { userId, provider: "bedrock", model: "test-haiku", now: latest })).toMatchObject({ kind: "added" });
    const haiku = (await readUserModels(env.DB, userId)).find((m) => m.model === "test-haiku")!;
    expect(haiku.addedAt).toBe(NOW.toISOString());
    expect(haiku.test?.at).toBe(latest.toISOString());

    await runCheck(env.DB, plugins, userId, "bedrock", latest);
    expect(plugin.calls.at(-1)!.model).toBe("test-haiku");
  });

  it("refuses a form posted from another site", async () => {
    const response = await handleAddModel(
      request("/bedrock/pick", { method: "POST", body: new URLSearchParams({ model: "test-sonnet" }), headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" } }),
      { db: env.DB, plugins, userId, viewer: "owner", now: NOW },
    );
    expect(response.status).toBe(403);
    expect(plugin.calls).toHaveLength(0);
  });
});

describe("Add a model on Microsoft Foundry", () => {
  let keyPem: string;
  let ISSUER_KEYS: string;
  const LABEL = ["PRIVATE", "KEY"].join(" ");
  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
    keyPem = `-----BEGIN ${LABEL}-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END ${LABEL}-----\n`;
    ISSUER_KEYS = issuerKeys("k1", [await issuerKey("k1")]);
  });

  // Foundry answers only the deployments it has: Claude Sonnet 5.5 deployed
  // as "claude-sonnet-5-5" and as "my-sonnet", GPT-6-luna as "gpt-6-luna",
  // "claude-haiku-5-5" running Claude Haiku 5.5, and "claude-opus-5" running
  // Claude Opus 5.5.
  function foundry() {
    const deployments: Record<string, string> = {
      "claude-sonnet-5-5": "claude-sonnet-5-5", "my-sonnet": "claude-sonnet-5-5", "claude-haiku-5-5": "claude-haiku-5-5", "claude-opus-5": "claude-opus-5-5-20261101",
    };
    const notFound = () => Response.json({ error: { code: "DeploymentNotFound", message: "The API deployment for this resource does not exist." } }, { status: 404 });
    const { fetcher, sent } = scriptedFetch([
      [/^https:\/\/login\.microsoftonline\.com\//, () => Response.json({ token_type: "Bearer", expires_in: 4500, access_token: "entra-access-token" })],
      [/\/anthropic\/v1\/messages$/, (s: Sent) => {
        const name = JSON.parse(s.body).model as string;
        const model = deployments[name];
        if (!model) return notFound();
        return Response.json({ type: "message", model, content: [{ type: "text", text: "OK" }], usage: { input_tokens: 14, output_tokens: 2 } });
      }],
      [/\/openai\/v1\/chat\/completions$/, (s: Sent) => {
        const name = JSON.parse(s.body).model as string;
        if (name !== "gpt-6-luna") return notFound();
        return Response.json({ model: "gpt-6-luna-2026-10-01", choices: [{ message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 15, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0 } } });
      }],
    ]);
    const plugin = foundryPlugin({ APP_ORIGIN, ISSUER_KEYS, ENTRA_CLIENT_ID: "client-1", ENTRA_CERT_KEY: keyPem, ENTRA_CERT_THUMBPRINT: "thumb" }, fetcher, () => NOW);
    return { plugins: { foundry: plugin } as PluginRegistry, sent, plugin };
  }

  const connectFoundry = async (regs: PluginRegistry) => writeConnection(env.DB, userId, regs.foundry!, { tenantId: TENANT, endpoint: ENDPOINT }, NOW);

  it("fills in the deployment name with the model ID, and lists Foundry's Claude models with no price yet", async () => {
    const { plugins: regs } = foundry();
    await connectFoundry(regs);
    const page = await (await open(regs, "?provider=foundry")).text();
    expect(page).toContain('<label class="small" for="dep-foundry-Claude-Sonnet-5-5">Deployment name</label>');
    expect(page).toContain('name="deployment" value="claude-sonnet-5-5"');
    expect(page).toContain('name="deployment" value="gpt-6-luna"');
    // The catalog's own ID, dots kept.
    expect(page).toContain('name="deployment" value="gpt-5.1"');
    expect(page).toContain("Change it only if you named it differently at Foundry.");
    const at = page.indexOf("<strong>Claude Haiku 5.5</strong>");
    const tr = page.slice(at, page.indexOf("</tr>", at));
    expect(tr).toContain("no price yet");
    expect(tr).toContain("waiting for the maintainers&#39; reading of its listing");
    expect(tr).toContain("Cannot be picked");
    expect(page).toContain("Strongest");
  });

  it("adds Claude under the suggested name, and under a name the user changed it to", async () => {
    const { plugins: regs, sent } = foundry();
    await connectFoundry(regs);
    expect(await addModel(env.DB, regs, { userId, provider: "foundry", model: "Claude Sonnet 5.5", deployment: "", now: NOW })).toMatchObject({
      kind: "added", model: { deployment: "claude-sonnet-5-5", test: { repliedModel: "claude-sonnet-5-5", text: "OK" } },
    });
    expect(await addModel(env.DB, regs, { userId, provider: "foundry", model: "Claude Sonnet 5.5", deployment: "my-sonnet", now: NOW })).toMatchObject({
      kind: "added", model: { deployment: "my-sonnet" },
    });
    const calls = sent.filter((s) => s.url.endsWith("/messages")).map((s) => JSON.parse(s.body).model);
    expect(calls).toEqual(["claude-sonnet-5-5", "my-sonnet"]);
    expect((await readUserModels(env.DB, userId)).map((m) => [m.model, m.deployment])).toEqual([["Claude Sonnet 5.5", "my-sonnet"]]);
  });

  it("calls a model that is not Claude in Chat Completions, and costs it from the price table", async () => {
    const { plugins: regs, sent } = foundry();
    await connectFoundry(regs);
    const outcome = await addModel(env.DB, regs, { userId, provider: "foundry", model: "GPT-6-luna", now: NOW });
    expect(outcome).toMatchObject({ kind: "added", model: { deployment: "gpt-6-luna", test: { repliedModel: "gpt-6-luna-2026-10-01", usage: { input: 15, output: 4 } } } });
    const call = sent.find((s) => s.url.endsWith("/chat/completions"))!;
    expect(call.url).toBe(`${ENDPOINT}/openai/v1/chat/completions`);
    expect(call.headers.get("authorization")).toBe("Bearer entra-access-token");
    expect(JSON.parse(call.body)).toMatchObject({ model: "gpt-6-luna", max_completion_tokens: 5 });
  });

  it("shows a misspelt deployment name's plain reason and adds nothing", async () => {
    const { plugins: regs } = foundry();
    await connectFoundry(regs);
    const response = await pick(regs, "foundry", { model: "Claude Sonnet 5.5", deployment: "claude-sonet-5-5" });
    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).toContain("That deployment name or model ID doesn&#39;t exist here.");
    expect(page).toContain("Foundry replied: 404 · DeploymentNotFound · “The API deployment for this resource does not exist.”");
    expect(await readUserModels(env.DB, userId)).toEqual([]);
  });

  it("refuses a deployment that runs another model", async () => {
    const { plugins: regs } = foundry();
    await connectFoundry(regs);
    const page = await (await pick(regs, "foundry", { model: "Claude Sonnet 5.5", deployment: "claude-haiku-5-5" })).text();
    expect(page).toContain("Foundry&#39;s reply names another model (claude-haiku-5-5), not Claude Sonnet 5.5, so Claude Sonnet 5.5 was not added.");
    expect(page).toContain("type the name of the one that runs Claude Sonnet 5.5");
    expect(await readUserModels(env.DB, userId)).toEqual([]);
  });

  it("shows a model with no catalog ID in the app as \"cannot be picked\", and refuses it without calling Foundry", async () => {
    const { plugins: regs, sent } = foundry();
    await connectFoundry(regs);
    const page = await (await open(regs, "?provider=foundry")).text();
    const at = page.indexOf("<strong>DeepSeek V3.2 (Fireworks)</strong>");
    const tr = page.slice(at, page.indexOf("</tr>", at));
    expect(tr).toContain("$0.56 in · $1.68 out");
    expect(tr).toContain("Cannot be picked");
    expect(tr).toContain("not offered yet: the app has no Foundry ID for it");
    expect(tr).not.toContain('name="deployment"');
    expect(await addModel(env.DB, regs, { userId, provider: "foundry", model: "DeepSeek V3.2 (Fireworks)", now: NOW })).toMatchObject({ kind: "refused", reason: "cannot_call" });
    expect(sent).toHaveLength(0);
  });

  it("refuses a deployment named for the picked model whose reply names a newer listed model that extends its ID", async () => {
    const { plugins: regs } = foundry();
    await connectFoundry(regs);
    const outcome = await addModel(env.DB, regs, { userId, provider: "foundry", model: "Claude Opus 5", now: NOW });
    expect(outcome).toMatchObject({ kind: "refused", reason: "wrong_model", reply: { repliedModel: "claude-opus-5-5-20261101" } });
    expect(await readUserModels(env.DB, userId)).toEqual([]);
  });

  it("refuses a name Foundry cannot have without calling it", async () => {
    const { plugins: regs, sent } = foundry();
    await connectFoundry(regs);
    expect(await addModel(env.DB, regs, { userId, provider: "foundry", model: "GPT-6-luna", deployment: "has spaces/and slashes", now: NOW })).toMatchObject({ kind: "refused", reason: "bad_deployment" });
    expect(sent).toHaveLength(0);
  });

  it("says \"Foundry's name for the model\" on a friend's screen, never \"deployment name\", and sends Admin only the item and its reason", async () => {
    const { plugins: regs } = foundry();
    await connectFoundry(regs);
    const page = await (await pick(regs, "foundry", { model: "Claude Sonnet 5.5", deployment: "claude-sonet-5-5" }, userId, "friend")).text();
    expect(page).toContain("Foundry&#39;s name for the model");
    expect(page).toContain("<strong>That name or model ID doesn&#39;t exist here.</strong>");
    expect(page).not.toContain("Deployment name");
    expect(page).not.toContain("deployment name is filled in");
    expect(page).toContain("Ask Admin for help");
    const sent = await (await pick(regs, "foundry", { model: "Claude Sonnet 5.5", reason: "no_such_model" }, userId, "friend", "help")).text();
    expect(sent).toContain("Sent to Admin: this item&#39;s name and its plain reason only.");
    const { results } = await env.DB.prepare("SELECT item, reason FROM help_requests WHERE user_id = ?").bind(userId).all();
    expect(results).toEqual([{ item: "Add a model: Claude Sonnet 5.5", reason: "That name or model ID doesn't exist here." }]);
    expect((await pick(regs, "foundry", { model: "Claude Sonnet 5.5", reason: "no_such_model" }, userId, "owner", "help")).status).toBe(403);
  });
});

describe("Add a model on Google Vertex AI: Gemini", () => {
  it("calls Gemini's generateContent and checks the model its reply names", async () => {
    const ISSUER_KEYS = issuerKeys("k1", [await issuerKey("k1")]);
    let version = "gemini-3.5-flash-001";
    const { fetcher, sent } = scriptedFetch([
      [/sts\.googleapis\.com/, () => Response.json({ access_token: "federated" })],
      [/:generateContent$/, () => Response.json({ modelVersion: version, candidates: [{ content: { parts: [{ text: "OK" }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1, thoughtsTokenCount: 3 } })],
    ]);
    const vertex = vertexPlugin({ APP_ORIGIN, ISSUER_KEYS, GOOGLE_WIF_PROVIDER: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q" }, fetcher, () => NOW);
    const regs: PluginRegistry = { vertex };
    await writeConnection(env.DB, userId, vertex, { projectId: "example-project-123" }, NOW);
    expect(await addModel(env.DB, regs, { userId, provider: "vertex", model: "Gemini 3.5 Flash", now: NOW })).toMatchObject({
      kind: "added", model: { location: "us", test: { repliedModel: "gemini-3.5-flash-001", usage: { input: 8, output: 4 } } },
    });
    const call = sent.find((s) => s.url.endsWith(":generateContent"))!;
    expect(call.url).toBe("https://aiplatform.us.rep.googleapis.com/v1/projects/example-project-123/locations/us/publishers/google/models/gemini-3.5-flash:generateContent");
    expect(JSON.parse(call.body)).toEqual({ contents: [{ role: "user", parts: [{ text: "Reply with the single word OK." }] }], generationConfig: { maxOutputTokens: 5 } });

    version = "gemini-3.5-flash-lite-001";
    expect(await addModel(env.DB, regs, { userId, provider: "vertex", model: "Gemini 3.5 Flash", now: NOW })).toMatchObject({ kind: "refused", reason: "wrong_model" });
  });
});

describe("the model a reply names", () => {
  it("is the picked one with a version or date after it, never a longer name", () => {
    expect(namesPickedModel("claude-haiku-5-5", "claude-haiku-5-5")).toBe(true);
    expect(namesPickedModel("claude-haiku-5-5-20261001", "claude-haiku-5-5")).toBe(true);
    expect(namesPickedModel("gemini-3.5-flash-001", geminiModelId("Gemini 3.5 Flash"))).toBe(true);
    expect(namesPickedModel("gpt-6.1-2026-10-01", "gpt-6-1")).toBe(true);
    expect(namesPickedModel("publishers/google/models/gemini-3.5-flash", "gemini-3.5-flash")).toBe(true);
    expect(namesPickedModel("gemini-3.5-flash-lite", "gemini-3.5-flash")).toBe(false);
    expect(namesPickedModel("claude-sonnet-5-5", "claude-haiku-5-5")).toBe(false);
    expect(namesPickedModel("claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5")).toBe(true);
    // Not a newer model whose ID extends the picked one's, listed or not.
    expect(namesPickedModel("claude-opus-5-5-20261101", "claude-opus-5")).toBe(false);
    expect(namesPickedModel("claude-opus-5-5-20261101", "claude-opus-5", undefined, ["claude-opus-5-5"])).toBe(false);
    expect(namesPickedModel("claude-opus-5-20261101", "claude-opus-5", undefined, ["claude-opus-5-5"])).toBe(true);
    expect(namesPickedModel("gpt-5.1-2025-11-13", "gpt-5", undefined, ["gpt-5.1"])).toBe(false);
    expect(namesPickedModel("claude-opus-5-5-fast", "claude-opus-5-5")).toBe(false);
    expect(namesPickedModel("gemini-3.5-flash-preview", "gemini-3.5-flash")).toBe(false);
    // A four-digit stamp is a version too.
    expect(namesPickedModel("grok-4-0709", "grok-4")).toBe(true);
    expect(namesPickedModel("Codestral-2501", "codestral")).toBe(true);
    expect(namesPickedModel("deepseek-v4-flash-0731", "DeepSeek-V4-Flash")).toBe(true);
    // Nor a reply that also names a longer listed model with a stamp after it.
    expect(namesPickedModel("deepseek-v4-flash-0731", "DeepSeek-V4-Flash", undefined, ["DeepSeek-V4-Flash-0731"])).toBe(false);
    // A reply that only echoes the user's own deployment name names no model.
    expect(namesPickedModel("my-sonnet", "claude-sonnet-5-5", "my-sonnet")).toBe(true);
    // Unless the name is another listed model's ID.
    expect(namesPickedModel("claude-haiku-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", ["claude-haiku-5-5"])).toBe(false);
  });

  it("reads Chat Completions and Gemini usage as disjoint counts", () => {
    expect(usageFromChatCompletions({ usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } })).toEqual({
      input: 40, cachedInput: 60, cacheWrite: 0, cacheWrite1h: 0, output: 7, longPrompt: false,
    });
    expect(usageFromGemini({ usageMetadata: { promptTokenCount: 250_000, cachedContentTokenCount: 1000, candidatesTokenCount: 5, thoughtsTokenCount: 2 } })).toEqual({
      input: 249_000, cachedInput: 1000, cacheWrite: 0, cacheWrite1h: 0, output: 7, longPrompt: true,
    });
  });
});
