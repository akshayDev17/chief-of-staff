import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { bedrockPlugin } from "../src/providers/bedrock";
import { readCheck } from "../src/providers/check";
import { foundryPlugin } from "../src/providers/foundry";
import { formatCost, handleProviders, PROVIDERS_PATH, type Viewer } from "../src/providers/page";
import { vertexPlugin } from "../src/providers/vertex";
import { writeSnapshot } from "../src/prices/store";
import { setBudget } from "../src/proxy/budgets";
import { readConnection } from "../src/proxy/connections";
import { ENV, generateKey, serveCerts, signToken, type TestKey } from "./access-fixture";
import { APP_ORIGIN, issuerKey, issuerKeys, scriptedFetch, stsCredentials, stsError, type Sent } from "./issuer-fixture";
import { userFor } from "./test-plugin";

const NOW = new Date("2026-11-25T10:00:00Z");
let ISSUER_KEYS: string;
let accessKey: TestKey;
let userId: string;

beforeAll(async () => {
  ISSUER_KEYS = issuerKeys("k1", [await issuerKey("k1")]);
  accessKey = await generateKey("kid-providers-page");
});
afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  userId = (await userFor("test-sub")).id;
  const row = (tokenKind: "input" | "output", usdPerMTok: number) => ({
    provider: "bedrock" as const, model: "Claude Haiku 5.5", deployment: "global" as const, region: "us-east-1", tokenKind, longPrompt: false, batch: false,
    usdPerMTok, source: "aws-price-list" as const, dateRead: "2026-11-24", stale: false, disagreement: false,
  });
  await writeSnapshot(env.DB, { takenAt: "2026-11-24T06:00:00Z", status: "good", results: [], rows: [row("input", 0.1), row("output", 0.5)] });
});

function world(converse: () => Response = () => Response.json({ output: { message: { content: [{ text: "OK" }] } }, usage: { inputTokens: 38, outputTokens: 3 } }), stack = true) {
  const { fetcher } = scriptedFetch([
    [/sts\.us-east-1/, (s: Sent) => {
      const action = new URLSearchParams(s.body).get("Action")!;
      if (action === "AssumeRoleWithWebIdentity") return stsCredentials(action, "ASIAAPP");
      return stack ? stsCredentials(action, "ASIAUSER") : stsError("AccessDenied", "not authorized to perform: sts:AssumeRole");
    }],
    [/bedrock-runtime/, converse],
    [/cloudformation/, () => new Response("", { status: 403 })],
  ]);
  const config = { APP_ORIGIN, ISSUER_KEYS, AWS_APP_ROLE_ARN: "arn:aws:iam::111122223333:role/chief-of-staff-app", BEDROCK_TEMPLATE_URL: "https://t.example/v1.0.0.json", ENTRA_CLIENT_ID: "client-1", GOOGLE_SERVICE_ACCOUNT: "chief-of-staff-models@owner.iam.gserviceaccount.com" };
  return { bedrock: bedrockPlugin(config, fetcher, () => NOW), foundry: foundryPlugin(config, fetcher, () => NOW), vertex: vertexPlugin(config, fetcher, () => NOW) };
}

const open = async (plugins: ReturnType<typeof world>, path = "", init: RequestInit = {}, viewer: Viewer = "owner") =>
  handleProviders(new Request(`${APP_ORIGIN}${PROVIDERS_PATH}${path}`, init), { db: env.DB, plugins, userId, viewer, appOrigin: APP_ORIGIN, now: NOW });
const post = (plugins: ReturnType<typeof world>, path: string, fields: Record<string, string> = {}, viewer: Viewer = "owner", origin = APP_ORIGIN) =>
  open(plugins, path, { method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded", origin } }, viewer);
const text = async (r: Response) => r.text();

describe("Models › Setup › Providers", () => {
  it("offers one Connect button per plug-in, with each guide's checked-on date and vendor pages, and no table", async () => {
    const page = await text(await open(world()));
    for (const name of ["Connect Amazon Bedrock", "Connect Microsoft Foundry", "Connect Google Vertex AI"]) expect(page).toContain(name);
    expect(page).toContain("Guide checked on 2026&#8209;11&#8209;25 against the vendor's own pages");
    expect(page).toContain('href="https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-create-stacks-quick-create-links.html"');
    expect(page).toContain('name="accountId"');
    expect(page).toContain('pattern="\\d{12}"');
    expect(page).not.toContain("<table");
    expect(page).not.toMatch(/design only|DESIGN ONLY|example; the real text/i);
    expect(page).toContain("You connect all three; a friend usually connects one.");
    expect(page).not.toContain("Ask Admin");
  });

  it("recommends Bedrock to a friend and opens it first", async () => {
    const page = await text(await open(world(), "", {}, "friend"));
    expect(page).toContain('<span class="pill accent">Recommended for friends</span> Amazon Bedrock has the fewest steps.');
    expect(page).toMatch(/class="on" aria-current="page">Connect Amazon Bedrock/);
    expect(page).not.toContain("You connect all three");
  });

  it("opens AWS's ready-filled stack on Connect, in a new tab, and shows the test call that ran by itself", async () => {
    const plugins = world();
    const form = await text(await open(plugins));
    expect(form).toMatch(/<form method="post" action="\/models\/setup\/providers\/bedrock\/connect" target="_blank" data-reload>/);
    const response = await post(plugins, "/bedrock/connect", { accountId: "123456789012" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/^https:\/\/us-east-1\.console\.aws\.amazon\.com\/cloudformation\/home\?region=us-east-1#\/stacks\/create\/review\?templateURL=/);
    const page = await text(await open(plugins, "?provider=bedrock"));
    expect(page).toContain('<strong>Connected</strong> <span class="pill ok">no key held</span>');
    expect(page).toContain("To revoke it on the provider’s side: delete the “chief-of-staff” stack in AWS CloudFormation.");
    expect(page).toContain('<p class="tc-verdict"><strong>Test call passed</strong> (ran by itself)</p>');
    expect(page).toContain('<p class="tc-reply">Bedrock replied: 200 OK · global.anthropic.claude-haiku-5-5 (Global) · “OK”</p>');
    expect(page).toContain("38 input and 3 output tokens · under $0.0001 · connected; a connection has no end date");
    expect(page).toContain("<strong>Region:</strong> chosen by the app from what your model supports: Global. The test call proves it.");
    expect(page).toContain("<strong>Monthly budget:</strong> not set yet");
    expect(page).toContain('Connect Amazon Bedrock <span aria-label="connected">✓</span>');
  });

  it("shows a failure as three lines: the plain reason, the provider's own words, and the fix with its buttons", async () => {
    const plugins = world(undefined, false);
    await post(plugins, "/bedrock/connect", { accountId: "123456789012" });
    const page = await text(await open(plugins));
    expect(page).toContain('<p class="tc-verdict"><strong>The connection isn&#39;t set up yet, or was removed.</strong></p>');
    expect(page).toContain('<p class="tc-reply">Bedrock replied: 403 · AccessDenied · “not authorized to perform: sts:AssumeRole”</p>');
    expect(page).toContain("Create the stack again with Connect Amazon Bedrock, then try again.");
    expect(page).toMatch(/<a class="btn small secondary" href="https:\/\/us-east-1\.console\.aws\.amazon\.com[^"]+" target="_blank" rel="noopener noreferrer">Connect Amazon Bedrock<\/a>/);
    expect(page).toContain('<form method="post" action="/models/setup/providers/bedrock/retry"><button type="submit" class="btn small">Try again</button></form>');
    // Still waiting for the stack: the page refreshes by itself.
    expect(page).toContain('<meta http-equiv="refresh" content="30">');
    expect(page).not.toContain("Ask Admin for help");
    const friend = await text(await open(plugins, "", {}, "friend"));
    expect(friend).toContain("Ask Admin for help");
    expect(friend).toContain("Only you see the provider's reply. “Ask Admin for help” sends only this item's name and the plain reason.");
  });

  it("shows 'still switching this on' with the provider's reply and the next try", async () => {
    const plugins = world(() => Response.json({ message: "Marketplace Agreement Pending" }, { status: 403, headers: { "x-amzn-ErrorType": "AccessDeniedException" } }));
    await post(plugins, "/bedrock/connect", { accountId: "123456789012" });
    const page = await text(await open(plugins));
    expect(page).toContain("<strong>AWS is still switching this on; we&#39;ll keep retrying and tick this item by ourselves.</strong>");
    expect(page).toContain("Bedrock replied: 403 · AccessDeniedException · “Marketplace Agreement Pending”");
    expect(page).toContain("Next try at 10:15 UTC · you can move on to the next item.");
  });

  it("escapes the provider's own words", async () => {
    const plugins = world(() => Response.json({ message: "<script>alert(1)</script>" }, { status: 400, headers: { "x-amzn-ErrorType": "ValidationException" } }));
    await post(plugins, "/bedrock/connect", { accountId: "123456789012" });
    const page = await text(await open(plugins));
    expect(page).toContain("“&lt;script&gt;alert(1)&lt;/script&gt;”");
    expect(page).not.toContain("<script>alert(1)");
  });

  it("asks before disconnecting, says how to revoke on the provider's side, and then disconnects", async () => {
    const plugins = world();
    await post(plugins, "/bedrock/connect", { accountId: "123456789012" });
    const confirm = await text(await open(plugins, "?provider=bedrock&disconnect=1"));
    expect(confirm).toContain('<h2 id="disc-title">Disconnect Amazon Bedrock?</h2>');
    expect(confirm).toContain("Its models stop answering for you at once. To remove the grant on the provider’s side too: delete the “chief-of-staff” stack in AWS CloudFormation.");
    expect(confirm).toContain('href="/models/setup/providers?provider=bedrock">Cancel</a>');
    const response = await post(plugins, "/bedrock/disconnect");
    expect(response.status).toBe(303);
    expect(await readConnection(env.DB, userId, "bedrock")).toBeUndefined();
    expect(await text(await open(plugins))).toContain('name="accountId"');
  });

  it("changes the region and tests it", async () => {
    const plugins = world();
    await post(plugins, "/bedrock/connect", { accountId: "123456789012" });
    const change = await text(await open(plugins, "?provider=bedrock&change=region"));
    expect(change).toContain('<option value="global" selected>Global</option><option value="cross-region">US cross-Region</option>');
    expect((await post(plugins, "/bedrock/region", { region: "cross-region" })).status).toBe(303);
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ region: "cross-region", regionSetBy: "user" });
    expect(await text(await open(plugins))).toContain("<strong>Region:</strong> US cross-Region, chosen by you.");
  });

  it("shows the monthly budget once set", async () => {
    const plugins = world();
    await post(plugins, "/bedrock/connect", { accountId: "123456789012" });
    await setBudget(env.DB, userId, "bedrock", 30, "accepted", NOW);
    expect(await text(await open(plugins))).toContain('<strong>Monthly budget:</strong> $30 · <a href="/models/setup/budgets">Budgets</a>');
  });

  it("shows the Vertex AI service account with a copy button and the role command before connecting", async () => {
    const page = await text(await open(world(), "?provider=vertex"));
    expect(page).toContain('<span class="mono">chief-of-staff-models@owner.iam.gserviceaccount.com</span> <button type="button" class="btn small ghost" data-copy="chief-of-staff-models@owner.iam.gserviceaccount.com">Copy</button>');
    expect(page).toContain("gcloud iam roles create chiefOfStaffModelCaller --project=YOUR_PROJECT_ID");
    expect(page).not.toContain('target="_blank" data-reload');
  });

  it("sends Foundry to Microsoft's consent page and says so while waiting", async () => {
    const plugins = world();
    const response = await post(plugins, "/foundry/connect", { endpoint: "https://example-resource.services.ai.azure.com" });
    expect(response.headers.get("location")).toMatch(/^https:\/\/login\.microsoftonline\.com\/organizations\/adminconsent\?client_id=client-1/);
    expect(await text(await open(plugins, "?provider=foundry"))).toContain("Waiting for Microsoft's consent page");
    const refused = await open(plugins, "/foundry/consented?error=access_denied&error_description=The+admin+canceled+the+request&state=x");
    expect(refused.status).toBe(400);
  });

  it("refuses a bad field with its plain problem, and a form from another site", async () => {
    const plugins = world();
    const bad = await post(plugins, "/bedrock/connect", { accountId: "12" });
    expect(bad.status).toBe(400);
    expect(await text(bad)).toContain('<div class="banner warn" role="alert">An AWS account ID is 12 digits.</div>');
    expect((await post(plugins, "/bedrock/connect", { accountId: "123456789012" }, "owner", "https://evil.example")).status).toBe(403);
    expect(await readConnection(env.DB, userId, "bedrock")).toBeUndefined();
    expect((await post(plugins, "/nope/connect")).status).toBe(404);
    expect((await open(plugins, "/bedrock/connect")).status).toBe(405);
  });

  it("lets a friend ask Admin for help, and not the owner", async () => {
    const plugins = world(undefined, false);
    await post(plugins, "/bedrock/connect", { accountId: "123456789012" }, "friend");
    expect((await post(plugins, "/bedrock/help", {}, "owner")).status).toBe(403);
    const sent = await post(plugins, "/bedrock/help", {}, "friend");
    expect(await text(sent)).toContain("Sent to Admin: this item&#39;s name and its plain reason only.");
  });

  it("formats a test call's cost", () => {
    expect(formatCost(0.00002)).toBe("under $0.0001");
    expect(formatCost(0.00042)).toBe("$0.0004");
    expect(formatCost(0.42)).toBe("$0.42");
  });
});

describe("the Worker's providers route", () => {
  const send = async (path: string, withToken = true) => {
    serveCerts(() => [accessKey]);
    const headers = withToken ? { "cf-access-jwt-assertion": await signToken(accessKey) } : undefined;
    return worker.fetch(new Request(`${APP_ORIGIN}${path}`, { headers }), { ...ENV, DB: env.DB, APP_ORIGIN });
  };

  it("is behind the Access check", async () => {
    expect((await send(PROVIDERS_PATH, false)).status).toBe(403);
  });

  it("renders for the signed-in owner, before T10 has configured any provider", async () => {
    const response = await send(PROVIDERS_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const page = await response.text();
    expect(page).toContain("<title>Models · Providers · Chief of staff</title>");
    expect(await (await send(`${PROVIDERS_PATH}?provider=vertex`)).text()).toContain("shown once Admin has set up the app's Google identity");
  });

  it("links Providers from the Budgets page", async () => {
    expect(await (await send("/models/setup/budgets")).text()).toContain('<a href="/models/setup/providers">Providers</a>');
  });
});
