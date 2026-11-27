import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { bedrockPlugin } from "../src/providers/bedrock";
import { readCheck } from "../src/providers/check";
import { foundryPlugin } from "../src/providers/foundry";
import { PROVIDERS_PATH } from "../src/paths";
import { formatCost, handleProviders, type Viewer } from "../src/providers/page";
import { vertexPlugin } from "../src/providers/vertex";
import { writeSnapshot } from "../src/prices/store";
import { setBudget } from "../src/proxy/budgets";
import { handleBudgets } from "../src/proxy/budgets-page";
import { readConnection } from "../src/proxy/connections";
import { ENV, generateKey, serveCerts, signToken, type TestKey } from "./access-fixture";
import { APP_ORIGIN, fakeMicrosoft, issuerKey, issuerKeys, scriptedFetch, stsCredentials, stsError, type Sent } from "./issuer-fixture";
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
    provider: "bedrock" as const, model: "Nova 2.0 Lite", deployment: "global" as const, region: "us-east-1", tokenKind, longPrompt: false, batch: false,
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
  const config = { APP_ORIGIN, ISSUER_KEYS, AWS_APP_ROLE_ARN: "arn:aws:iam::111122223333:role/chief-of-staff-app", BEDROCK_TEMPLATE_URL: "https://t.example/v1.0.0.json", ENTRA_CLIENT_ID: "client-1", FOUNDRY_CREDENTIAL: "federated", GOOGLE_WIF_PROVIDER: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/w" };
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
    expect(page).toContain("Guide checked on 2026&#8209;11&#8209;27 against the vendor's own pages");
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
    expect(form).toMatch(/<form method="post" action="\/chief-of-staff\/models\/setup\/providers\/bedrock\/connect" target="_blank" data-reload>/);
    const response = await post(plugins, "/bedrock/connect", { accountId: "123456789012" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/^https:\/\/us-east-1\.console\.aws\.amazon\.com\/cloudformation\/home\?region=us-east-1#\/stacks\/create\/review\?templateURL=/);
    const page = await text(await open(plugins, "?provider=bedrock"));
    expect(page).toContain('<strong>Connected</strong> <span class="pill ok">no key held</span>');
    expect(page).toContain("To revoke it on the provider’s side: delete the “chief-of-staff” stack in AWS CloudFormation.");
    expect(page).toContain('<p class="tc-verdict"><strong>Test call passed</strong> (ran by itself)</p>');
    expect(page).toContain('<p class="tc-reply">Bedrock replied: 200 OK · global.amazon.nova-2-lite-v1:0 (Global) · “OK”</p>');
    expect(page).toContain("38 input and 3 output tokens · under $0.0001 · connected; a connection has no end date");
    expect(page).toContain("<strong>Region:</strong> chosen by the app from what Nova 2.0 Lite supports: Global. The test call proves it.");
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
    expect(page).toContain('<form method="post" action="/chief-of-staff/models/setup/providers/bedrock/retry"><button type="submit" class="btn small">Try again</button></form>');
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

  it("re-runs a test call waiting for a spent budget when the budget is raised, and offers Try again meanwhile", async () => {
    let calls = 0;
    // 300,000 input tokens at $0.10 per 1M: each test call costs $0.03.
    const plugins = world(() => {
      calls += 1;
      return Response.json({ output: { message: { content: [{ text: "OK" }] } }, usage: { inputTokens: 300_000, outputTokens: 0 } });
    });
    const saveBudget = (amount: string) =>
      handleBudgets(
        new Request(`${APP_ORIGIN}/chief-of-staff/models/setup/budgets`, { method: "POST", body: new URLSearchParams({ provider: "bedrock", amount, per_day: "5" }), headers: { origin: APP_ORIGIN } }),
        env.DB, plugins, userId, NOW,
      );
    await post(plugins, "/bedrock/connect", { accountId: "123456789012" });
    expect(calls).toBe(1);
    // A $0.01 budget the connect's own test call already spent: Try again waits, calling nothing.
    expect((await saveBudget("0.01")).status).toBe(303);
    await post(plugins, "/bedrock/retry");
    expect(calls).toBe(1);
    const waiting = await text(await open(plugins, "?provider=bedrock"));
    expect(waiting).toContain("This month&#39;s budget for Amazon Bedrock is spent, so the test call waits until the 1st.");
    expect(waiting).toContain('<form method="post" action="/chief-of-staff/models/setup/providers/bedrock/retry"><button type="submit" class="btn small">Try again</button></form>');
    // Raised but still spent: the test call keeps waiting and nothing reaches the provider.
    expect((await saveBudget("0.02")).status).toBe(303);
    expect(calls).toBe(1);
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ result: { reason: "budget_spent" }, nextTryAt: "2026-12-01T00:00:00.000Z" });
    // Raised past this month's spend: the test call runs at once and passes.
    expect((await saveBudget("5")).status).toBe(303);
    expect(calls).toBe(2);
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ state: "passed", result: { verdict: "passed" } });
    expect(await text(await open(plugins, "?provider=bedrock"))).toContain('<p class="tc-verdict"><strong>Test call passed</strong> (ran by itself)</p>');
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
    expect(confirm).toContain('href="/chief-of-staff/models/setup/providers?provider=bedrock">Cancel</a>');
    const response = await post(plugins, "/bedrock/disconnect");
    expect(response.status).toBe(303);
    expect(await readConnection(env.DB, userId, "bedrock")).toBeUndefined();
    expect(await text(await open(plugins))).toContain('name="accountId"');
  });

  it("changes the region and tests it", async () => {
    const plugins = world();
    await post(plugins, "/bedrock/connect", { accountId: "123456789012" });
    const change = await text(await open(plugins, "?provider=bedrock&change=region"));
    expect(change).toContain('<option value="global" selected>Global</option><option value="us-east-1">US cross-Region from us-east-1</option>');
    expect((await post(plugins, "/bedrock/region", { region: "us-east-1" })).status).toBe(303);
    expect(await readCheck(env.DB, userId, "bedrock")).toMatchObject({ region: "us-east-1", regionSetBy: "user" });
    expect(await text(await open(plugins))).toContain("<strong>Region:</strong> US cross-Region from us-east-1, chosen by you.");
  });

  it("lists the provider's models below a passed Connect in an accessible dropdown, with prices and coloured strengths, and tests a chosen one there", async () => {
    const failing = world(undefined, false);
    await post(failing, "/bedrock/connect", { accountId: "123456789012" });
    expect(await text(await open(failing))).not.toContain('role="listbox"');

    const plugins = world();
    await post(plugins, "/bedrock/connect", { accountId: "123456789012" });
    const page = await text(await open(plugins, "?provider=bedrock"));
    expect(page).toContain('<h3 id="bedrock-models-h">Your models at Amazon Bedrock</h3>');
    expect(page).toContain('<button type="button" class="lb-btn" id="bedrock-models-button" aria-haspopup="listbox" aria-expanded="false" aria-controls="bedrock-models" aria-labelledby="bedrock-models-label bedrock-models-button" hidden>Choose a model to test</button>');
    expect(page).toContain('<ul role="listbox" id="bedrock-models" class="lb" aria-labelledby="bedrock-models-label" tabindex="-1" hidden>');
    expect(page).toContain('<li role="option" id="opt-bedrock-Nova-2-0-Lite" data-model="Nova 2.0 Lite" aria-selected="false">');
    expect(page).toContain('<span class="lb-name">Nova 2.0 Lite</span><span class="tier tier-s">Smallest</span>');
    expect(page).toContain("$0.10 in · $0.50 out per million tokens · Global, chosen by the app");
    // The strengths' bands, each with its own colour and its name in words.
    expect(page).toContain('<span class="tier tier-s">Smallest</span> under $0.50 per million tokens, <span class="tier tier-m">Middle</span> $0.50 to under $2.50, <span class="tier tier-l">Strongest</span> $2.50 and up.');
    // Without scripts, a plain list does the same.
    expect(page).toContain('<noscript><div class="row"><select class="f" name="model" aria-label="Model"><option value="Nova 2.0 Lite">Nova 2.0 Lite · $0.10 in · $0.50 out · Smallest</option></select>');
    expect(page).toContain('document.querySelectorAll("form[data-listbox]")');
    // The old page is gone from the links.
    expect(page).not.toContain("/models/setup/add");
    expect(page).toContain('<a class="btn" href="/chief-of-staff/models/setup/tasks">Next: the model for each task</a>');

    const chosen = await post(plugins, "/bedrock/choose", { model: "Nova 2.0 Lite" });
    expect(chosen.status).toBe(200);
    const result = await text(chosen);
    expect(result).toContain("<strong>Nova 2.0 Lite added.</strong> Its test call ran once and passed.");
    expect(result).toContain('<li role="option" id="opt-bedrock-Nova-2-0-Lite" data-model="Nova 2.0 Lite" aria-selected="false" class="added">');
  });

  it("shows the monthly budget once set", async () => {
    const plugins = world();
    await post(plugins, "/bedrock/connect", { accountId: "123456789012" });
    await setBudget(env.DB, userId, "bedrock", 30, "accepted", NOW);
    expect(await text(await open(plugins))).toContain('<strong>Monthly budget:</strong> $30 · <a href="/chief-of-staff/models/setup/budgets">Budgets</a>');
  });

  it("shows the user's own Google identity with a copy button and the role command before connecting, never a shared service account", async () => {
    const page = await text(await open(world(), "?provider=vertex"));
    const own = `principal://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/subject/${userId}`;
    expect(page).toContain(`Your own identity: <span class="mono" style="word-break:break-all">${own}</span> <button type="button" class="btn small ghost" data-copy="${own}">Copy</button>`);
    expect(page).toContain("paste your own identity shown below (copy button), pick that role and Save. It is yours alone, so no other user of this app can use your project.");
    expect(page).not.toContain("gserviceaccount.com");
    expect(page).not.toContain("service-account email");
    expect(page).toContain("gcloud iam roles create chiefOfStaffModelCaller --project=YOUR_PROJECT_ID");
    expect(page).not.toContain('target="_blank" data-reload');
  });

  it("keeps the user's own identity and the role command, with the project ID, on screen after Connect until the test call passes", async () => {
    const vertexRow = (tokenKind: "input" | "output", usdPerMTok: number) => ({
      provider: "vertex" as const, model: "Claude Haiku 5.5", deployment: "regional" as const, region: "us", tokenKind, longPrompt: false, batch: false,
      usdPerMTok, source: "google-catalog" as const, dateRead: "2026-11-24", stale: false, disagreement: false,
    });
    await writeSnapshot(env.DB, { takenAt: "2026-11-24T07:00:00Z", status: "good", results: [], rows: [vertexRow("input", 0.1), vertexRow("output", 0.5)] });
    let granted = false;
    const { fetcher } = scriptedFetch([
      [/^https:\/\/sts\.googleapis\.com\//, () => Response.json({ access_token: "federated-token", token_type: "Bearer", expires_in: 3599 })],
      [/aiplatform/, () =>
        granted
          ? Response.json({ content: [{ type: "text", text: "OK" }], usage: { input_tokens: 11, output_tokens: 2 } })
          : Response.json({ error: { code: 403, message: "Permission 'aiplatform.endpoints.predict' denied", status: "PERMISSION_DENIED" } }, { status: 403 })],
    ]);
    const vertex = vertexPlugin({ APP_ORIGIN, ISSUER_KEYS, GOOGLE_WIF_PROVIDER: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/w" }, fetcher, () => NOW);
    const plugins = { ...world(), vertex };
    await post(plugins, "/vertex/connect", { projectId: "example-project-123" });
    const waiting = await text(await open(plugins, "?provider=vertex"));
    expect(waiting).toContain("Vertex AI replied: 403 · PERMISSION_DENIED");
    expect(waiting).toContain(`data-copy="principal://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/subject/${userId}">Copy</button>`);
    expect(waiting).toContain("Grant your own identity shown above its role on your project");
    expect(waiting).toContain("gcloud iam roles create chiefOfStaffModelCaller --project=example-project-123");
    granted = true;
    await post(plugins, "/vertex/retry");
    const passed = await text(await open(plugins, "?provider=vertex"));
    expect(passed).toContain("Test call passed");
    expect(passed).not.toContain("gcloud iam roles create");
  });

  it("sends Foundry to Microsoft's sign-in at the typed directory, then on to admin consent in the signed-in tenant, and says so while waiting", async () => {
    const TENANT = "11111111-2222-4333-8444-555555555555";
    const ms = await fakeMicrosoft();
    let nonce = "";
    const t0 = NOW.getTime() / 1000;
    const { fetcher } = scriptedFetch([
      [new RegExp(`${TENANT}/oauth2/v2\\.0/token$`), async () =>
        Response.json({ id_token: await ms.idToken({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: "client-1", tid: TENANT, idp: "live.com", nonce, iat: t0, nbf: t0, exp: t0 + 3600 }) })],
      [/discovery\/v2\.0\/keys$/, () => Response.json(ms.keySet)],
    ]);
    const plugins = { ...world(), foundry: foundryPlugin({ APP_ORIGIN, ISSUER_KEYS, ENTRA_CLIENT_ID: "client-1", FOUNDRY_CREDENTIAL: "federated" }, fetcher, () => NOW) };
    const guide = await text(await open(plugins, "?provider=foundry"));
    expect(guide).toContain("sign in with your personal Microsoft account, then tap <strong>Accept</strong>. Your directory is taken from this sign-in, so only you can connect it. A work or school account can't connect Foundry here: connect Amazon Bedrock or Google Vertex AI instead.");
    expect(guide).toContain("Directory (tenant) ID");
    const response = await post(plugins, "/foundry/connect", { endpoint: "https://example-resource.services.ai.azure.com", tenantId: TENANT });
    const signIn = new URL(response.headers.get("location")!);
    expect(signIn.origin + signIn.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
    nonce = signIn.searchParams.get("nonce")!;
    expect(await text(await open(plugins, "?provider=foundry"))).toContain("Waiting for Microsoft: sign in there and tap Accept");

    const signedIn = await open(plugins, `/foundry/signed-in?code=c&state=${signIn.searchParams.get("state")}`);
    expect(signedIn.status).toBe(303);
    const consent = new URL(signedIn.headers.get("location")!);
    expect(consent.origin + consent.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/adminconsent`);

    const forged = await open(plugins, `/foundry/consented?tenant=99999999-8888-4777-8666-555555555555&admin_consent=True&state=${consent.searchParams.get("state")}`);
    expect(forged.status).toBe(400);
    expect(await text(forged)).toContain("different organisation than the one you signed in with, so nothing was saved");
    expect(await readConnection(env.DB, userId, "foundry")).toBeUndefined();
    expect((await open(plugins, "/foundry/signed-in", { method: "POST" })).status).toBe(405);
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
    expect(await (await send("/chief-of-staff/models/setup/budgets")).text()).toContain('<a href="/chief-of-staff/models/setup/providers">Providers and models</a>');
  });
});
