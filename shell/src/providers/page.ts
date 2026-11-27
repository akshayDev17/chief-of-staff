// Models › Setup › Providers, rendered on the server (design T02 / T16): one
// "Connect <Provider>" button for every registered plug-in (OpenRouter, the
// one provider since 2026-11-27), each with its action lines, its
// connection, its account line and, once connected, the model test.
//
//   GET  /chief-of-staff/models/setup/providers[?provider=<id>][&disconnect=1][&test-all=confirm][&tests=all|works|fails]
//   POST /chief-of-staff/models/setup/providers/<id>/connect      to the provider's own consent page
//   GET  /chief-of-staff/models/setup/providers/<id>/consented    back from it: the key into the vault, then to #test
//   POST /chief-of-staff/models/setup/providers/<id>/disconnect
//   POST /chief-of-staff/models/setup/providers/<id>/choose       model: its test call runs once
//   POST /chief-of-staff/models/setup/providers/<id>/model-help   friends only: a chosen model's refusal
//   POST /chief-of-staff/models/setup/providers/<id>/refresh      Refresh model list
//   POST /chief-of-staff/models/setup/providers/<id>/test-all     Test all models, after its confirm step
//   POST /chief-of-staff/models/setup/providers/<id>/add-tested   model: Add, on a model that passed in the latest Test all models
//
// There is no field to fill: Connect sends the user to the provider's own
// page, where they sign in and authorize the app, and the provider issues the
// app a key for their account, which goes straight into their vault. The key
// is never shown on any page. Back from that page the user lands at the
// model test (#test), highlighted, with focus on its dropdown; no test call
// runs by itself (the owner, 2026-11-27). Connected shows once the provider
// has authorized the app; the provider is usable once one of the user's
// models has passed its test call.
//
// The account line reads the provider's own figures for the key, live,
// server side, with the key from the vault (OpenRouter's GET /api/v1/key):
// whether the account has ever bought credit, who owns the key, its limit,
// what it has spent. It is how a user sees why paid calls are refused.
//
// Visible copy is the action lines only; every explanation is collapsed
// (the owner, 2026-11-27, of the old three-paragraph guide: "why not make it
// even more verbose ... so that the users learn to read a book in
// 30seconds?"). The Usage page, not built yet, is named but not linked.

import { readAccountList, refreshAccountList } from "../models/account-list";
import { addModel, listOffer, readUserModels, refusalText, type AddOutcome, type AddRefusal, type OfferRow } from "../models/add";
import { addTestedModel, planTestAll, readTestAll, startTestAll, type TestAllPlan, type TestAllRun } from "../models/test-all";
import { BUDGETS_PATH, PROVIDERS_PATH } from "../paths";
import { nextAction, setupTabsLine } from "../models/setup-tabs";
import { CONTROLS_CSS, esc, nbDate, PAGE_CSS } from "../prices/page";
import { refreshPrices } from "../prices/refresh";
import { currentSnapshot, readCurrentCatalog } from "../prices/store";
import { isProvider, PROVIDERS, type Provider } from "../prices/types";
import { readBudget } from "../proxy/budgets";
import { readConnection } from "../proxy/connections";
import type { AccountInfo, ConnectionFields, PlainReason, PluginRegistry, ProviderPlugin } from "../proxy/plugin";

import { callbackUrl, connectProvider, disconnectProvider, finishConsent, isConnected, readCheck, type Check } from "./check";
import { MODELS_CSS, MODELS_JS, modelsSection, TEST_ANCHOR, TIER_VARS, type TestsFilter } from "./models-panel";
import type { SecretStore } from "./secrets";

// Who is looking: the owner, or a friend the owner invited (who says
// "Admin" for the owner and gets "Ask Admin for help").
export type Viewer = "owner" | "friend";

export interface ProviderPanel {
  plugin: ProviderPlugin;
  connection?: ConnectionFields;
  check?: Check;
  monthlyBudget?: number;
  // The selected panel's account, read live; `unread` when it could not be.
  account?: AccountInfo | "unread";
  // How many of the user's models at this provider have passed their test call.
  passedModels?: number;
  // The selected panel's model list, once connected.
  models?: {
    rows: OfferRow[];
    // When the provider's own list was read, and the account's.
    catalogReadAt?: string;
    accountReadAt?: string;
    plan: TestAllPlan;
    run?: TestAllRun;
  };
}

export interface ProvidersPageInput {
  viewer: Viewer;
  userId: string;
  panels: ProviderPanel[];
  selected: Provider;
  confirmDisconnect: boolean;
  confirmTestAll: boolean;
  testsFilter: TestsFilter;
  problem?: string;
  said?: string;
  // The result of choosing a model, shown under the model list.
  outcome?: AddOutcome;
  // The GET address that shows a Test all models run's progress: the page's
  // own, or for a page a form's POST returned, the run's results.
  progressHref: string;
  now: Date;
}

const providerHref = (provider: string, extra = ""): string => `${PROVIDERS_PATH}?provider=${provider}${extra}`;
const action = (provider: string, verb: string): string => `${PROVIDERS_PATH}/${provider}/${verb}`;

const hhmm = (iso: string): string => `${iso.slice(11, 16)} UTC`;

export const formatCost = (usd: number): string => {
  if (usd === 0) return "$0";
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return usd < 0.0001 ? "under $0.0001" : `$${usd.toFixed(4)}`;
};

const postButton = (href: string, label: string, cls = "btn small") =>
  `<form method="post" action="${href}"><button type="submit" class="${cls}">${esc(label)}</button></form>`;

const money = (n: number): string =>`$${n.toFixed(2)}`;

// The account line: one row of short facts, with Add credits when the
// account has never bought any.
function accountLine(panel: ProviderPanel): string {
  const a = panel.account;
  const name = panel.plugin.connect.guide.name;
  if (!a) return "";
  if (a === "unread") return `<p class="small acct"><strong>${esc(name)} account:</strong> <span class="muted">could not be read just now.</span></p>`;
  const facts = [
    a.freeTier ? "never bought credits" : "has bought credits",
    a.organizationId ? "organization key" : "personal key",
    a.limitUsd !== undefined ? `key limit ${money(a.limitUsd)}${a.limitRemainingUsd !== undefined ? `, ${money(a.limitRemainingUsd)} left` : ""}` : "no key limit",
    `key spent ${formatCost(a.usageUsd)}`,
  ];
  const credits = a.freeTier ? ` <a class="btn small" href="https://openrouter.ai/settings/credits" target="_blank" rel="noopener noreferrer">Add credits</a>` : "";
  const details = [
    `<li>${a.freeTier ? "This account has never bought credits: paid models answer 402." : "This account has bought credits before."}</li>`,
    `<li>${a.organizationId ? `Owned by organization ${esc(a.organizationId)}.` : "Owned by your own account, not an organization."}</li>`,
    a.workspaceId ? `<li>Spends in workspace ${esc(a.workspaceId)}.</li>` : "",
    a.limitReset ? `<li>The key's limit resets ${esc(a.limitReset)}.</li>` : "",
    a.usageMonthlyUsd !== undefined ? `<li>This key spent ${esc(formatCost(a.usageMonthlyUsd))} this month.</li>` : "",
    a.freeDaily ? `<li>${a.freeDaily.remaining.toLocaleString("en-US")} of ${a.freeDaily.limit.toLocaleString("en-US")} free-model requests left today.</li>` : "",
    `<li>Credits sit on one account or organization. Connect again and pick the one with credits.</li>`,
  ].join("");
  return `<p class="small acct"><strong>${esc(name)} account:</strong> ${facts.map(esc).join(" · ")}${credits}</p>
<details class="more"><summary>About this account</summary><ul class="small about">${details}</ul></details>`;
}

function connectForm(panel: ProviderPanel): string {
  const { plugin, check } = panel;
  const name = plugin.connect.guide.name;
  const waiting = check?.consentState ? `<p class="small muted">Waiting for ${esc(name)}. Authorize there, or connect again.</p>` : "";
  return `${waiting}<form method="post" action="${action(plugin.provider, "connect")}">
<div class="row" style="margin-top:8px"><button type="submit" class="btn">Connect ${esc(name)}</button></div>
</form>`;
}

function aboutConnect(plugin: ProviderPlugin): string {
  const g = plugin.connect.guide;
  const pages = g.pages.map((p) => `<a href="${esc(p.href)}" rel="noopener noreferrer">${esc(p.label)}</a>`).join(" · ");
  return `<details class="more"><summary>What this does</summary><ul class="small about">${g.about.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<p class="small muted">Checked on ${nbDate(g.checkedOn)} · ${pages}</p></details>`;
}

function panelHtml(panel: ProviderPanel, input: ProvidersPageInput): string {
  const { plugin, connection, check } = panel;
  const g = plugin.connect.guide;
  const steps = `<ol class="steps">${g.steps.map((s) => `<li>${s}</li>`).join("")}</ol>`;
  const help = input.viewer === "friend" ? postButton(action(plugin.provider, "help"), "Ask Admin for help", "btn help-btn small") : "";
  if (!connection) return `${steps}${connectForm(panel)}${help}${aboutConnect(plugin)}`;
  const revoked = check?.state === "revoked";
  const status = revoked ? `Removed on ${esc(g.short)}'s side` : "Connected";
  const revokeLinks = g.revokeLinks(connection).map((l) => `<a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`).join(" · ");
  const head = `<p class="status"><strong>${status}</strong> <span class="pill ok">key in your vault</span> <a class="btn small danger" href="${providerHref(plugin.provider, "&disconnect=1")}">Disconnect</a></p>`;
  const dialog = input.confirmDisconnect
    ? `<div class="dialog-backdrop"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="disc-title"><h2 id="disc-title">Disconnect ${esc(g.name)}?</h2>
<p class="small">The app deletes the key from your vault. Its models stop answering for you at once.</p>
<p class="small">The key stays valid on ${esc(g.short)} until you delete it there: ${esc(g.revoke)}</p>
<div class="row" style="justify-content:flex-end"><a class="btn small ghost" href="${providerHref(plugin.provider)}">Cancel</a>${postButton(action(plugin.provider, "disconnect"), "Disconnect", "btn small danger")}</div></div></div>`
    : "";
  const passed = panel.passedModels ?? 0;
  const usable = revoked
    ? ""
    : passed
      ? `<p class="small ok-line">Usable: ${passed} ${passed === 1 ? "model" : "models"} passed.</p>`
      : `<p class="small"><strong>Not usable yet:</strong> test a model below.</p>`;
  const budget = panel.monthlyBudget ? `$${panel.monthlyBudget.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "not set yet";
  const keyDetails = `<details class="more"><summary>Key and budget</summary><ul class="small about">
<li>Monthly budget here: ${budget} · <a href="${BUDGETS_PATH}">Budgets</a></li>
<li>To revoke the key on ${esc(g.short)}: ${esc(g.revoke)} ${revokeLinks}</li>
</ul></details>`;
  const note = input.viewer === "friend" ? `<p class="small muted">Only you see ${esc(g.short)}'s replies.</p>${passed ? "" : postButton(action(plugin.provider, "help"), "Ask Admin for help", "btn help-btn small")}` : "";
  const reconnect = revoked ? `<p class="small">Connect again to get a new key.</p>${connectForm(panel)}` : "";
  const models =
    isConnected(connection, check) && panel.models
      ? modelsSection({
          plugin,
          viewer: input.viewer,
          rows: panel.models.rows,
          outcome: input.outcome,
          catalogReadAt: panel.models.catalogReadAt,
          accountReadAt: panel.models.accountReadAt,
          plan: panel.models.plan,
          run: panel.models.run,
          confirmTestAll: input.confirmTestAll,
          testsFilter: input.testsFilter,
          formatCost,
          now: input.now,
        })
      : "";
  return `${head}${dialog}${accountLine(panel)}${usable}${keyDetails}${reconnect}${note}${models}`;
}

export function renderProvidersPage(input: ProvidersPageInput): string {
  const selected = input.panels.find((p) => p.plugin.provider === input.selected) ?? input.panels[0]!;
  const tabs =
    input.panels.length > 1
      ? `<nav class="row" aria-label="Providers" style="margin-top:10px"><span class="seg">${input.panels
          .map((p) => {
            const on = p === selected;
            const tick = isConnected(p.connection, p.check) ? ' <span aria-label="connected">✓</span>' : "";
            return `<a href="${providerHref(p.plugin.provider)}"${on ? ' class="on" aria-current="page"' : ""}>Connect ${esc(p.plugin.connect.guide.name)}${tick}</a>`;
          })
          .join("")}</span></nav>`
      : `<h3 style="margin:10px 0 0">Connect ${esc(selected.plugin.connect.guide.name)}${isConnected(selected.connection, selected.check) ? ' <span aria-label="connected">✓</span>' : ""}</h3>`;
  // While a Test all models run goes on, the page shows its progress: a
  // script loads input.progressHref again, never a form sent again, and
  // never while a model is being chosen (models-panel.ts MODELS_JS); without
  // scripts, a refresh to that address every 20 seconds.
  const running = Boolean(selected.models?.run && !selected.models.run.finishedAt);
  const progress = esc(input.progressHref);
  const refresh = running ? `<noscript><meta http-equiv="refresh" content="20; url=${progress}"></noscript>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}
<title>Models · Providers · Chief of staff</title>
<style>${PAGE_CSS}${CONTROLS_CSS}${CSS}${TIER_VARS}${MODELS_CSS}</style>
</head>
<body${running ? ` data-reload-every="20" data-reload-to="${progress}"` : ""}>
<main class="screen">
<h1>Models</h1>
<div class="subtabs"><span class="on">Setup</span><span aria-disabled="true">Usage</span></div>
${setupTabsLine(PROVIDERS_PATH)}
<h2>Model provider</h2>
<p>OpenRouter reaches every maker's models. You pay it for your own calls.</p>
${input.problem ? `<div class="banner warn" role="alert">${esc(input.problem)}</div>` : ""}
${input.said ? `<div class="banner ok" role="status">${esc(input.said)}</div>` : ""}
<section class="card">
${tabs}
<div style="margin-top:10px">${panelHtml(selected, input)}</div>
</section>
<div class="row" style="margin-top:12px">${nextAction(PROVIDERS_PATH, selected.passedModels ? "btn" : "btn secondary")}</div>
</main>
<script>${MODELS_JS}
</script>
</body>
</html>`;
}

const CSS = `
:root { --danger: #9b2c2c; --danger-soft: #fbe4e4; --accent-soft: #e2ecf6; --danger-btn: #b91c1c; --danger-btn-hover: #991b1b; }
@media (prefers-color-scheme: dark) { :root { --danger: #f3a6a6; --danger-soft: #3a1f1f; --accent-soft: #1d2a38; } }
.mono, .cmd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.cmd { font-size: .8rem; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
label.f { display: block; font-size: .85rem; margin: 8px 0 4px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; max-width: 100%; }
.seg > a { padding: 4px 11px; color: var(--text); text-decoration: none; white-space: nowrap; }
.seg > a + a { border-left: 1px solid var(--line); }
.seg > a:hover { background: var(--accent-soft); }
.seg > a.on, .seg > a.on + a { border-left-color: var(--accent); }
.seg > a.on { background: var(--accent); color: var(--card); }
.seg > a:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
@media (max-width: 759px) {
  .seg { display: flex; flex-direction: column; border-radius: 12px; width: 100%; }
  .seg > a { padding: 8px 12px; white-space: normal; }
  .seg > a + a, .seg > a.on, .seg > a.on + a { border-left: 0; border-top: 1px solid var(--line); }
  .seg > a.on, .seg > a.on + a { border-top-color: var(--accent); }
  .seg > a:first-child { border-top: 0; }
}
.pill.ok { background: var(--ok-soft); color: var(--ok); }
.pill.accent { background: var(--accent-soft); color: var(--accent); }
.btn.small { font-size: .85rem; min-height: 28px; padding: 3px 9px; }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--line); }
.btn[aria-disabled] { opacity: .55; cursor: default; }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.btn.refresh:not(:disabled):hover { filter: brightness(.85); }
.btn.refresh:disabled { opacity: .55; cursor: not-allowed; }
.btn.danger { background: var(--danger-btn); border-color: var(--danger-btn); color: #fff; }
.btn.danger:hover { background: var(--danger-btn-hover); border-color: var(--danger-btn-hover); }
.btn.danger:focus-visible { outline-color: var(--danger-btn); }
.help-btn { border-color: var(--line); background: var(--card); color: var(--text); }
.tc { border: 1px solid var(--ok); border-radius: 10px; padding: 10px 12px; margin-top: 8px; background: var(--ok-soft); }
.tc-bad { border-color: var(--danger); background: var(--danger-soft); }
.tc-sw { border-color: var(--warn); background: var(--warn-soft); }
.tc p { margin: 0 0 4px; }
.tc-reply { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .8rem; color: var(--muted); overflow-wrap: anywhere; }
.tc .row { margin-top: 6px; }
.dialog-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .45); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 50; }
.dialog { background: var(--card); color: var(--text); border: 1px solid var(--line); border-radius: 14px; padding: 18px; max-width: 420px; width: 100%; }
.dialog h2 { margin-top: 0; }
ol.steps { padding-left: 22px; margin: 6px 0; overflow-wrap: anywhere; }
ol.steps li + li { margin-top: 2px; }
.status { margin: 8px 0 4px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.acct { margin: 4px 0; overflow-wrap: anywhere; }
.acct .btn { margin-left: 4px; }
.tc-fix { overflow-wrap: anywhere; }
`;
// The account behind the user's key, read live with the key from the vault.
async function readAccount(plugin: ProviderPlugin, connection: ConnectionFields, userId: string): Promise<AccountInfo | undefined> {
  if (!plugin.connect.readAccount) return undefined;
  try {
    return await plugin.connect.readAccount(await plugin.mintCredential(connection, { userId }));
  } catch {
    return undefined;
  }
}

async function pageInput(
  db: D1Database,
  plugins: PluginRegistry,
  userId: string,
  viewer: Viewer,
  url: URL,
  now: Date,
  extra: { problem?: string; said?: string; selected?: Provider; outcome?: AddOutcome } = {},
): Promise<ProvidersPageInput> {
  const registered = PROVIDERS.filter((p) => plugins[p]);
  const panels = await Promise.all(
    registered.map(async (provider) => ({
      plugin: plugins[provider]!,
      connection: await readConnection(db, userId, provider),
      check: await readCheck(db, userId, provider),
      monthlyBudget: (await readBudget(db, userId, provider))?.monthlyUsd,
    })),
  );
  const asked = url.searchParams.get("provider");
  const selected = extra.selected ?? registered.find((p) => p === asked) ?? registered[0]!;
  // Only the selected panel's model list is read: it prices every model.
  const shown: ProviderPanel | undefined = panels.find((p) => p.plugin.provider === selected);
  if (shown?.connection && isConnected(shown.connection, shown.check)) {
    const rows = await listOffer(db, plugins, userId, selected);
    shown.passedModels = rows.filter((r) => r.added?.test).length;
    shown.account = (await readAccount(shown.plugin, shown.connection, userId)) ?? "unread";
    shown.models = {
      rows,
      catalogReadAt: (await readCurrentCatalog(db))?.readAt,
      accountReadAt: (await readAccountList(db, userId, selected))?.readAt,
      plan: await planTestAll(db, plugins, userId, selected, now, rows),
      run: await readTestAll(db, userId, selected),
    };
  }
  const filter = url.searchParams.get("tests");
  const testsFilter: TestsFilter = filter === "works" || filter === "fails" ? filter : "all";
  return {
    viewer,
    userId,
    panels,
    selected,
    confirmDisconnect: url.searchParams.get("disconnect") === "1",
    confirmTestAll: url.searchParams.get("test-all") === "confirm",
    testsFilter,
    problem: extra.problem,
    said: extra.said,
    outcome: extra.outcome,
    progressHref: url.pathname === PROVIDERS_PATH ? `${url.pathname}${url.search}` : `${providerHref(selected, `&tests=${testsFilter}`)}#${selected}-test-all`,
    now,
  };
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const ROUTE = new RegExp(`^${PROVIDERS_PATH}(?:/([a-z]+)/(connect|consented|disconnect|help|choose|model-help|refresh|test-all|add-tested))?$`);

// The refusals of a chosen model a friend can ask Admin about, by the sentence they saw.
const MODEL_HELP_REASONS: ReadonlySet<string> = new Set<AddRefusal | PlainReason>([
  "not_set_up", "no_credits", "no_such_model", "no_permission", "busy", "app_not_configured", "no_reply", "refused",
  "wrong_model", "budget_spent", "cannot_call", "no_price", "not_passed",
]);

// Refresh model list may read again a minute after the last read.
export const REFRESH_GAP_MS = 60_000;

export const isProvidersPath = (pathname: string): boolean => ROUTE.test(pathname);

// Every route is scoped to the signed-in user.
export async function handleProviders(
  request: Request,
  input: {
    db: D1Database;
    plugins: PluginRegistry;
    // The plug-ins again, after a refresh read the provider's model list.
    readPlugins: () => Promise<PluginRegistry>;
    secrets: SecretStore;
    userId: string;
    viewer: Viewer;
    appOrigin: string | undefined;
    now: Date;
    fetcher?: typeof fetch;
  },
): Promise<Response> {
  const { db, secrets, userId, viewer, now } = input;
  let { plugins } = input;
  const url = new URL(request.url);
  const [, providerPart, verb] = ROUTE.exec(url.pathname) ?? [];
  const page = async (extra: { problem?: string; said?: string; selected?: Provider; outcome?: AddOutcome } = {}, status = 200) =>
    html(renderProvidersPage(await pageInput(db, plugins, userId, viewer, url, now, extra)), status);
  const back = (provider: string, extra = "", anchor = "") => Response.redirect(`${url.origin}${providerHref(provider, extra)}${anchor}`, 303);
  // The price table and the provider's model list, read now when there is
  // none yet or it is over a minute old.
  const refreshCatalog = async (force: boolean): Promise<void> => {
    const snapshot = await currentSnapshot(db);
    const catalog = await readCurrentCatalog(db);
    if (!force && catalog) return;
    if (snapshot && catalog && now.getTime() - Date.parse(snapshot.takenAt) < REFRESH_GAP_MS) return;
    await refreshPrices({ db, fetcher: input.fetcher ?? fetch, now });
    plugins = await input.readPlugins();
  };

  if (!verb) return request.method === "GET" ? page() : new Response(null, { status: 405 });
  if (!isProvider(providerPart ?? "") || !plugins[providerPart as Provider]) return new Response(null, { status: 404 });
  const provider = providerPart as Provider;

  if (verb === "consented") {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    // The model test below needs the provider's model list and prices.
    await refreshCatalog(false);
    const outcome = await finishConsent(db, plugins, secrets, { userId, provider, returned: url.searchParams, now });
    if ("problem" in outcome) return page({ problem: outcome.problem, selected: provider }, 400);
    // Straight to the model test, highlighted, with no call made.
    return back(provider, "", `#${TEST_ANCHOR}`);
  }

  if (request.method !== "POST") return new Response(null, { status: 405 });
  // A form posted from another site is refused.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return new Response(null, { status: 403 });
  const form = await request.formData();
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };

  switch (verb) {
    case "connect": {
      const callback = input.appOrigin ? callbackUrl(input.appOrigin, PROVIDERS_PATH, provider) : undefined;
      const outcome = await connectProvider(db, plugins, secrets, { userId, provider, callbackUrl: callback, now });
      if ("problem" in outcome) return page({ problem: outcome.problem, selected: provider }, 400);
      return "open" in outcome ? Response.redirect(outcome.open, 303) : back(provider);
    }
    case "disconnect":
      await disconnectProvider(db, secrets, userId, provider);
      return back(provider);
    case "choose": {
      if (!field("model")) return page({ problem: "Choose a model first.", selected: provider }, 400);
      const outcome = await addModel(db, plugins, { userId, provider, model: field("model"), now });
      return page({ outcome, selected: provider }, outcome.kind === "added" ? 200 : 400);
    }
    case "refresh": {
      const account = await readAccountList(db, userId, provider);
      const snapshot = await currentSnapshot(db);
      const recent = (iso: string | undefined) => iso !== undefined && now.getTime() - Date.parse(iso) < REFRESH_GAP_MS;
      if (recent(account?.readAt) && recent(snapshot?.takenAt)) {
        const from = new Date(Math.max(Date.parse(account!.readAt), Date.parse(snapshot!.takenAt)) + REFRESH_GAP_MS).toISOString();
        return page({ problem: `The model list was read less than a minute ago. Refresh it again from ${hhmm(from)}.`, selected: provider }, 429);
      }
      await refreshCatalog(true);
      const read = await refreshAccountList(db, plugins, userId, provider, now);
      return "problem" in read ? page({ problem: read.problem, selected: provider }, 502) : back(provider);
    }
    case "add-tested": {
      if (!field("model")) return page({ problem: "Choose a model first.", selected: provider }, 400);
      const outcome = await addTestedModel(db, plugins, userId, provider, field("model"), now);
      return page({ outcome, selected: provider }, outcome.kind === "added" ? 200 : 400);
    }
    case "test-all": {
      const started = await startTestAll(db, plugins, userId, provider, now);
      return "problem" in started ? page({ problem: started.problem, selected: provider }, 400) : back(provider, "&tests=all", `#${provider}-test-all`);
    }
    case "model-help": {
      // "Ask Admin for help" on a chosen model: its name and the plain
      // reason only, never the provider's reply.
      if (viewer !== "friend") return new Response(null, { status: 403 });
      const reason = field("reason");
      const model = field("model").slice(0, 120);
      if (!MODEL_HELP_REASONS.has(reason) || !model) return page({ problem: "There is nothing to ask about here.", selected: provider }, 400);
      const text = refusalText({ kind: "refused", model, reason: reason as AddRefusal }, plugins[provider]);
      await db
        .prepare("INSERT INTO help_requests (user_id, item, reason, at) VALUES (?, ?, ?, ?)")
        .bind(userId, `Choose a model: ${model}`, text, now.toISOString())
        .run();
      return page({ said: "Sent to Admin: this item's name and its plain reason only.", selected: provider });
    }
    case "help": {
      // A friend asks Admin; the owner has no one above to ask.
      if (viewer !== "friend") return new Response(null, { status: 403 });
      const plugin = plugins[provider]!;
      const connected = isConnected(await readConnection(db, userId, provider), await readCheck(db, userId, provider));
      const passed = (await readUserModels(db, userId)).some((m) => m.provider === provider);
      if (passed) return page({ problem: "There is nothing to ask about here.", selected: provider }, 400);
      await db
        .prepare("INSERT INTO help_requests (user_id, item, reason, at) VALUES (?, ?, ?, ?)")
        .bind(userId, `Connect ${plugin.connect.guide.name}`, connected ? "connected, no model has passed yet" : "not connected yet", now.toISOString())
        .run();
      return page({ said: "Sent to Admin: this item's name and its plain reason only.", selected: provider });
    }
  }
  return new Response(null, { status: 404 });
}
