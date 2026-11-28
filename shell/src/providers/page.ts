// Models › Setup › Providers, rendered on the server (design T02 / T16): the
// provider card (OpenRouter, the one provider since 2026-11-27) with its
// connection and account line, and once connected the model table
// (models-table.ts).
//
//   GET  /chief-of-staff/models/setup/providers[?provider=<id>][&<view>]       the page, or with Accept: application/json its <main>
//   POST /chief-of-staff/models/setup/providers/<id>/connect        to the provider's own consent page
//   GET  /chief-of-staff/models/setup/providers/<id>/consented      back from it: the key into the vault, then the page, search focused once
//   POST /chief-of-staff/models/setup/providers/<id>/disconnect
//   POST /chief-of-staff/models/setup/providers/<id>/test           model: its test call runs once (Test, or Try again); the result opens under its row
//   POST /chief-of-staff/models/setup/providers/<id>/check-account  model: reads the account's model list again
//   POST /chief-of-staff/models/setup/providers/<id>/cap            model, input, output: a router's price cap
//   POST /chief-of-staff/models/setup/providers/<id>/refresh        Refresh model list
//   POST /chief-of-staff/models/setup/providers/<id>/help           friends only
//   POST /chief-of-staff/models/setup/providers/<id>/model-help     friends only: a model's failed test
//
// Nothing reloads the page or changes its address (the owner, 2026-11-28):
// the page's script (page-script.ts) sends every form and view link in
// place with Accept: application/json, and the answer is the page's <main>
// for the resulting view, of which it swaps in the parts that changed. A
// form posted without the script gets a redirect to the same view as an
// address (post-redirect-get), with any problem in a flash cookie that the
// next page shows once, so a refresh re-runs nothing. A view (models-table.ts
// View) is only what to show: an open confirm, the cap editor, a result
// under a row; it changes nothing.
//
// There is no field to fill: Connect sends the user to the provider's own
// page, where they sign in and authorize the app, and the provider issues the
// app a key for their account, which goes straight into their vault. The key
// is never shown on any page. Back from that page the user lands on this
// page with the search field focused, once; no test call runs by itself (the
// owner, 2026-11-27).
//
// The account line reads the provider's own figures for the key, live,
// server side, with the key from the vault (OpenRouter's GET /api/v1/key):
// whether the account has ever bought credit, who owns the key, its limit,
// what it has spent. That read comes first, so the table's Ready rule
// (models/ready.ts) takes this visit's credit figure: credit added on
// OpenRouter makes its paid models Ready here with no click. A request that
// cannot change the card (a test, Check again) does not read it again: the
// card is sent as "keep yours", and the rule takes the figure last read.
//
// The app cannot delete the key on OpenRouter (openrouter.ts, "Revoking"), so
// Disconnect's confirmation opens that exact key's page there, named by the
// SHA-256 hash the record holds; the key itself never reaches the browser.

import { readAccountList, refreshAccountList } from "../models/account-list";
import { parsePriceCap, savePriceCap } from "../models/price-caps";
import { modelsSubtabs, nextAction, SETUP_TABS } from "../models/setup-tabs";
import { readAccountLive, readReadyModels, readTable } from "../models/ready";
import { readTaskRoutes } from "../models/tasks";
import { isVerdict, MODEL_HELP_REASONS, PRECHECK_REFUSALS, refusalFix, refusalText, testOne, type TestRefusal } from "../models/test-model";
import { BUDGETS_PATH, PROVIDERS_PATH } from "../paths";
import { isCurrentCatalog } from "../prices/openrouter";
import { esc, nbDate } from "../prices/page";
import { refreshPrices } from "../prices/refresh";
import { currentSnapshot, readCurrentCatalog } from "../prices/store";
import { isProvider, PROVIDERS, type Provider } from "../prices/types";
import { readBudget } from "../proxy/budgets";
import { readConnection } from "../proxy/connections";
import type { AccountInfo, ConnectionFields, PluginRegistry, ProviderPlugin } from "../proxy/plugin";

import { callbackUrl, connectProvider, disconnectProvider, finishConsent, isConnected, readCheck, removedText, CONNECT_AGAIN, type Check } from "./check";
import { formatCost, ICON, MAX_RESULTS, modelParts, nextStep, parseView, rowAnchor, viewQuery, type ModelsTableInput, type Step, type View, type Viewer } from "./models-table";
import { MAKER_CHIPS_HTML, MAKER_FILTER_HTML } from "../models/maker-filter";
import { NOSCRIPT_STYLE, PAGE_STYLE } from "./page-style";
import { PAGE_SCRIPT } from "./page-script";
import type { SecretStore } from "./secrets";

export { formatCost };
export type { Viewer };

// What a page shows once, after a redirect: a problem, a note sent to Admin,
// or the landing back from the consent page.
export interface Flash {
  problem?: string;
  details?: string;
  said?: string;
  landed?: boolean;
}

export interface PageState {
  viewer: Viewer;
  plugin: ProviderPlugin;
  connection?: ConnectionFields;
  check?: Check;
  connected: boolean;
  monthlyBudget?: number;
  // The account, read live; `unread` when it could not be; undefined when
  // the card is not rendered again.
  account?: AccountInfo | "unread";
  // How many of the provider's models are Ready.
  ready: number;
  table?: ModelsTableInput;
  view: View;
  flash: Flash;
  step?: Step;
  // Send the provider card as "keep yours": the request cannot change it.
  keepCard: boolean;
}

const action = (provider: string, verb: string): string => `${PROVIDERS_PATH}/${provider}/${verb}`;
const viewHref = (provider: string, view: View, anchor = ""): string => `${PROVIDERS_PATH}?${viewQuery(provider, view)}${anchor}`;
const hhmm = (iso: string): string => `${iso.slice(11, 16)} UTC`;
const money = (n: number): string => `$${n.toFixed(2)}`;
const newTab = (href: string, label: string, cls: string) => `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;

function accountFacts(a: AccountInfo): string {
  return [
    a.freeTier ? "never bought credits" : "has bought credits",
    a.organizationId ? "organization key" : "personal key",
    a.limitUsd !== undefined ? `key limit ${money(a.limitUsd)}${a.limitRemainingUsd !== undefined ? `, ${money(a.limitRemainingUsd)} left` : ""}` : "no key limit",
    `key spent ${formatCost(a.usageUsd)}`,
  ].join(" · ");
}

// "Also delete this key on OpenRouter: Open its page", the key's own page
// when the connection names it (revokeLinks puts it last, after the general
// page), else the provider's list of keys.
function alsoDelete(plugin: ProviderPlugin, connection: ConnectionFields | undefined): string {
  const short = esc(plugin.connect.guide.short);
  const general = plugin.connect.guide.revokeLinks(undefined);
  const links = plugin.connect.guide.revokeLinks(connection);
  const own = links.length > general.length ? links.at(-1) : undefined;
  if (own) return `<p class="why">Also delete this key on ${short}: ${newTab(own.href, "Open its page", "ext")}</p>`;
  const list = general.at(-1);
  return list ? `<p class="why">Also delete the key on ${short}: ${newTab(list.href, list.label, "ext")}</p>` : "";
}

function providerCard(state: PageState): string {
  const { plugin, connection, check, view } = state;
  const g = plugin.connect.guide;
  const p = plugin.provider;
  const connect = `<form method="post" action="${action(p, "connect")}"><button type="submit" class="btn ${state.step === "connect" ? "primary" : "outline"}" data-k="connect">Connect ${esc(g.name)}</button></form>`;
  const help = state.viewer === "friend" && !state.ready ? `<form method="post" action="${action(p, "help")}" data-fetch><button type="submit" class="btn small outline" data-k="help">Ask Admin for help</button></form>` : "";
  if (!connection) {
    const keys = g.revokeLinks(undefined).at(-1);
    const lines = view.disconnected
      ? `<p><strong>Disconnected.</strong> The key stays valid on ${esc(g.short)} until you delete it there.${keys ? ` ${newTab(keys.href, keys.label, "ext")}` : ""}</p>`
      : `<ol>${g.steps.map((s) => `<li>${s}</li>`).join("")}</ol>${check?.consentState ? `<p>Waiting for ${esc(g.name)}. Authorize there, or connect again.</p>` : ""}`;
    const about = `<details><summary>What this does</summary><ul class="small">${g.about.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>${g.newGrantEachTime ? `<p class="small">${esc(g.newGrantEachTime)}</p>` : ""}<p class="small">Checked on ${nbDate(g.checkedOn)}</p></details>`;
    return `<h3>${esc(g.name)} <span class="pill">Not connected</span></h3><div class="lines">${lines}</div><div class="acts">${connect}${help}</div>${view.disconnected ? "" : about}`;
  }
  if (!state.connected) {
    return `<h3>${esc(g.name)} <span class="pill warn">${esc(removedText(g.short))}</span></h3><div class="lines"><p>${CONNECT_AGAIN} to get a new key.</p></div><div class="acts">${connect}${help}</div>`;
  }
  const a = state.account;
  const account = a === "unread" || !a ? `<p><strong>Account:</strong> could not be read just now.</p>` : `<p><strong>Account:</strong> ${esc(accountFacts(a))}</p>`;
  const budget = state.monthlyBudget ? `$${state.monthlyBudget.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "not set yet";
  const friend = state.viewer === "friend" ? `<p>Only you see ${esc(g.short)}'s replies.</p>` : "";
  const lines = `<div class="lines">${account}<p><strong>Monthly budget here:</strong> ${budget} · <a href="${BUDGETS_PATH}">Budgets</a></p>${friend}</div>`;
  const head = `<h3>${esc(g.name)} <span class="pill ok">Connected · key in your vault</span></h3>`;
  if (view.confirm === "disconnect") {
    return `${head}${lines}<div class="acts"><form method="post" action="${action(p, "disconnect")}" data-fetch><button type="submit" class="btn small danger-o" data-k="disc-yes">Disconnect</button></form><a class="link" href="${esc(viewHref(p, {}))}" data-view data-k="disc-no" data-autofocus>Cancel</a></div>
<div class="confirm" role="alertdialog" aria-labelledby="disc-q"><p id="disc-q"><strong>Disconnect ${esc(g.name)}?</strong> The app deletes the key from your vault, and its models stop answering for you at once.</p>${alsoDelete(plugin, connection)}<details><summary>Details</summary><p class="small">The key stays valid on ${esc(g.short)} until you delete it there: ${esc(g.revoke)}</p></details></div>`;
  }
  const credits = a && a !== "unread" && a.freeTier && g.credits ? newTab(g.credits.href, g.credits.label, "btn small outline ext") : "";
  return `${head}${lines}<div class="acts">${credits}${help}<a class="link danger" href="${esc(viewHref(p, { confirm: "disconnect" }))}" data-view data-k="disc">Disconnect</a></div>`;
}

function bannerPart(state: PageState): string {
  const f = state.flash;
  const problem = !state.table && f.problem
    ? `<div class="banner warn" role="alert">${esc(f.problem)}${f.details ? `<details><summary>Details</summary><p class="small">${esc(f.details)}</p></details>` : ""}</div>`
    : "";
  const said = f.said ? `<div class="banner ok" role="status">${esc(f.said)}</div>` : "";
  return problem + said;
}

const tabsLine = (): string =>
  `<nav class="tabs" aria-label="Models setup">${SETUP_TABS.map((t) => (t.href === PROVIDERS_PATH ? `<span aria-current="page">${esc(t.label)}</span>` : `<a href="${t.href}">${esc(t.label)}</a>`)).join("")}</nav>`;

export function renderMain(state: PageState): string {
  const { plugin, table } = state;
  const g = plugin.connect.guide;
  const card = state.keepCard ? `<div class="panel provider" data-part="provider" data-keep></div>` : `<div class="panel provider" data-part="provider">${providerCard(state)}</div>`;
  let tests = "";
  if (table) {
    const parts = modelParts(table);
    const sub = `${state.flash.landed ? "Connected just now. " : ""}Ready models need no test. Tasks choose among them.`;
    tests = `<section class="block" id="test" aria-labelledby="h-test">
<div class="block-head"><h2 id="h-test">Your models</h2><p class="sub" id="test-sub">${sub}</p></div>
<div class="panel">
<div class="pane">
<div class="toolbar">
<div class="search" role="search">${ICON.search}<input type="search" id="pick-q" name="q" aria-label="Search models by name, maker or ID" aria-controls="pick-list" placeholder="Search name, maker or ID" autocomplete="off" spellcheck="false"><button type="button" class="clear-x" data-clear-q aria-label="Clear search">${ICON.x}</button></div>
${MAKER_FILTER_HTML}
<p class="count" id="pick-count" aria-live="polite"><span class="num">${table.rows.length}</span> models</p>
</div>
${MAKER_CHIPS_HTML}
<div data-part="err">${parts.err}</div>
<div class="strip-wrap" data-part="strip">${parts.strip}</div>
<div class="list-head" data-part="head">${parts.head}</div>
<div class="tbl-box" id="tbl-box" tabindex="0" role="region" aria-label="Models, scrolls"><ul class="rows" id="pick-list" aria-label="Models" data-part="rows">${parts.rows}</ul></div>
<div class="list-foot" data-part="foot">${parts.foot}</div>
</div>
</div>
</section>`;
  }
  return `<div class="title-row"><h1>Models</h1>${modelsSubtabs("setup")}</div>
${tabsLine()}
<div data-part="banner">${bannerPart(state)}</div>
<section class="block" aria-labelledby="h-provider">
<div class="block-head"><h2 id="h-provider">Model provider</h2><p class="sub">${esc(g.name)} reaches every maker's models. You pay it for your own calls.</p></div>
${card}
</section>
${tests}
<div class="next-row" data-part="next">${nextAction(PROVIDERS_PATH, state.step === "next" ? "btn primary" : "btn outline")}</div>`;
}

export function renderProvidersPage(state: PageState): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Models · Providers · Chief of staff</title>
<link rel="icon" href="data:,">
<style>${PAGE_STYLE}</style>
<noscript><style>${NOSCRIPT_STYLE}</style></noscript>
</head>
<body>
<main class="screen" id="screen" data-view="${esc(viewQuery(state.plugin.provider, state.view))}"${state.flash.landed ? " data-land" : ""}>
${renderMain(state)}
</main>
<script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}

// For each of `models`: the tasks whose saved main model it is, each with
// the fallback its calls fall to when it fails, if any.
async function tasksUsing(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider, models: string[]): Promise<Map<string, Array<{ task: string; fallback?: string }>>> {
  if (!models.length) return new Map();
  const { routes } = await readTaskRoutes(db, plugins, userId);
  return new Map(
    models.map((model) => [
      model,
      routes.flatMap((r) =>
        r.current?.main.provider === provider && r.current.main.model === model ? [{ task: r.task.label, ...(r.current.fallback ? { fallback: r.current.fallback.name ?? r.current.fallback.model } : {}) }] : [],
      ),
    ]),
  );
}

export async function readPageState(
  db: D1Database,
  plugins: PluginRegistry,
  input: { userId: string; viewer: Viewer; provider: Provider; view: View; flash: Flash; keepCard: boolean; now: Date },
): Promise<PageState> {
  const { userId, provider, view, flash, now } = input;
  const plugin = plugins[provider]!;
  const connection = await readConnection(db, userId, provider);
  const check = await readCheck(db, userId, provider);
  const connected = isConnected(connection, check);
  const monthlyBudget = (await readBudget(db, userId, provider))?.monthlyUsd;
  const state: PageState = { viewer: input.viewer, plugin, connection, check, connected, monthlyBudget, ready: 0, view, flash, keepCard: input.keepCard && connected };
  if (connection && connected) {
    // The live read first: its credit figure is the one the rows' Ready rule takes.
    if (!state.keepCard) state.account = (await readAccountLive(db, plugin, userId)) ?? "unread";
    const [{ rows, lines }, catalog] = await Promise.all([readTable(db, plugins, userId, provider), readCurrentCatalog(db)]);
    state.ready = rows.filter((r) => r.state === "ready").length;
    // A failed result under a row names the tasks that fall to their fallback.
    const failed = (view.results ?? []).filter((res) => rows.find((r) => r.model === res.model)?.latest?.state === "failed");
    const usedBy = await tasksUsing(db, plugins, userId, provider, failed.map((r) => r.model));
    const catalogCurrent = isCurrentCatalog(catalog);
    const noToolUse = (catalog?.models ?? []).filter((m) => plugin.connect.noToolUse?.(m.id) !== undefined).length;
    state.table = {
      plugin,
      viewer: input.viewer,
      rows,
      ...(catalog ? { catalog: { readAt: catalog.readAt, current: catalogCurrent, dropped: catalog.dropped, noToolUse } } : {}),
      usedBy,
      view,
      problem: flash.problem ? { text: flash.problem, details: flash.details } : undefined,
      ...(lines ? { lines } : {}),
      now,
    };
    state.step = nextStep({ connected: true, view, catalogCurrent });
    state.table.step = state.step;
  } else {
    state.step = "connect";
  }
  return state;
}

const ROUTE = new RegExp(`^${PROVIDERS_PATH}(?:/([a-z]+)/(connect|consented|disconnect|help|model-help|test|check-account|cap|refresh))?$`);

// Refresh model list may read again a minute after the last read.
export const REFRESH_GAP_MS = 60_000;

export const isProvidersPath = (pathname: string): boolean => ROUTE.test(pathname);

const FLASH_COOKIE = "cos_providers_flash";

function encodeFlash(flash: Flash): string {
  const bytes = new TextEncoder().encode(JSON.stringify(flash));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readFlash(request: Request): Flash | undefined {
  const raw = (request.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${FLASH_COOKIE}=`))?.slice(FLASH_COOKIE.length + 1);
  if (!raw) return undefined;
  try {
    const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const f = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as Flash;
    return {
      ...(typeof f.problem === "string" ? { problem: f.problem.slice(0, 500) } : {}),
      ...(typeof f.details === "string" ? { details: f.details.slice(0, 1000) } : {}),
      ...(typeof f.said === "string" ? { said: f.said.slice(0, 500) } : {}),
      ...(f.landed === true ? { landed: true } : {}),
    };
  } catch {
    return undefined;
  }
}

const flashCookie = (flash: Flash | undefined): string =>
  flash && Object.keys(flash).length
    ? `${FLASH_COOKIE}=${encodeFlash(flash)}; Path=${PROVIDERS_PATH}; Max-Age=300; HttpOnly; Secure; SameSite=Lax`
    : `${FLASH_COOKIE}=; Path=${PROVIDERS_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

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
  const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
  const registered = PROVIDERS.filter((p) => plugins[p]);
  if (!registered.length) return new Response(null, { status: 404 });

  // The page, or its <main> as JSON, for `view`.
  const show = async (provider: Provider, view: View, flash: Flash, extra: { focus?: string; keepCard?: boolean; status?: number; clearFlash?: boolean } = {}): Promise<Response> => {
    const state = await readPageState(db, plugins, { userId, viewer, provider, view, flash, keepCard: wantsJson && (extra.keepCard ?? false), now });
    if (wantsJson) {
      return new Response(JSON.stringify({ main: renderMain(state), view: viewQuery(provider, view), ...(extra.focus ? { focus: extra.focus } : {}) }), {
        status: extra.status ?? 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    if (extra.clearFlash) headers.append("set-cookie", flashCookie(undefined));
    return new Response(renderProvidersPage(state), { status: extra.status ?? 200, headers });
  };
  // After an action: in place, the resulting view; without the script, a
  // redirect to it, with any problem in the flash cookie.
  const done = (provider: Provider, view: View, extra: { flash?: Flash; focus?: string; anchor?: string; keepCard?: boolean } = {}): Promise<Response> | Response => {
    if (wantsJson) return show(provider, view, extra.flash ?? {}, { focus: extra.focus, keepCard: extra.keepCard });
    const headers = new Headers({ location: `${url.origin}${viewHref(provider, view, extra.anchor ?? "")}` });
    if (extra.flash) headers.append("set-cookie", flashCookie(extra.flash));
    return new Response(null, { status: 303, headers });
  };
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

  if (!verb) {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const asked = url.searchParams.get("provider") ?? "";
    const provider = registered.find((p) => p === asked) ?? registered[0]!;
    const flash = wantsJson ? undefined : readFlash(request);
    // Every visit, and every view, reads the account line live.
    const view = parseView(url.searchParams);
    return show(provider, view, flash ?? {}, { clearFlash: flash !== undefined });
  }
  if (!isProvider(providerPart ?? "") || !plugins[providerPart as Provider]) return new Response(null, { status: 404 });
  const provider = providerPart as Provider;
  const plugin = plugins[provider]!;

  if (verb === "consented") {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    // The model table needs the provider's model list and prices.
    await refreshCatalog(false);
    const outcome = await finishConsent(db, plugins, secrets, { userId, provider, returned: url.searchParams, now });
    if ("problem" in outcome) return show(provider, {}, { problem: outcome.problem }, { status: 400 });
    // To the page, with the search field focused once; no call made.
    const headers = new Headers({ location: `${url.origin}${viewHref(provider, {})}` });
    headers.append("set-cookie", flashCookie({ landed: true }));
    return new Response(null, { status: 303, headers });
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
  const model = field("model").slice(0, 200);

  switch (verb) {
    case "connect": {
      const callback = input.appOrigin ? callbackUrl(input.appOrigin, PROVIDERS_PATH, provider) : undefined;
      const outcome = await connectProvider(db, plugins, secrets, { userId, provider, callbackUrl: callback, now });
      if ("problem" in outcome) return done(provider, {}, { flash: { problem: outcome.problem } });
      return "open" in outcome ? Response.redirect(outcome.open, 303) : done(provider, {});
    }
    case "disconnect":
      await disconnectProvider(db, secrets, userId, provider);
      return done(provider, { disconnected: true }, { focus: "connect" });
    case "test": {
      if (!model) return done(provider, {}, { flash: { problem: "Choose a model to test." }, keepCard: true });
      const outcome = await testOne(db, plugins, { userId, provider, model, now });
      // A refusal that recorded no test is carried in the view itself.
      const unrecorded = outcome.kind === "refused" && (PRECHECK_REFUSALS.has(outcome.reason) || !isVerdict(outcome)) ? outcome : undefined;
      // In place, the results already shown stay under their rows.
      const shownBefore = wantsJson ? (parseView(new URLSearchParams(request.headers.get("x-cos-view") ?? "")).results ?? []) : [];
      const result = { model, ...(unrecorded ? { reason: unrecorded.reason, ...(unrecorded.reply ? { reply: unrecorded.reply } : {}) } : {}) };
      const results = [result, ...shownBefore.filter((r) => r.model !== model)].slice(0, MAX_RESULTS);
      return done(provider, { results }, { focus: `t-${model}`, anchor: `#${rowAnchor(model)}`, keepCard: true });
    }
    case "check-account": {
      if (!model) return done(provider, {}, { keepCard: true });
      const read = await refreshAccountList(db, plugins, userId, provider, now);
      if ("problem" in read) return done(provider, {}, { flash: { problem: read.problem, details: read.details }, keepCard: true });
      const allowed = (await readAccountList(db, userId, provider))?.models.has(model) ?? false;
      return done(provider, { notice: { model, kind: allowed ? "allowed" : "left-out" } }, { focus: allowed ? `t-${model}` : `ac-${model}`, anchor: `#${rowAnchor(model)}`, keepCard: true });
    }
    case "cap": {
      if (!model || !plugin.connect.isRouter?.(model)) return done(provider, {}, { flash: { problem: "Only a router takes a price cap." }, keepCard: true });
      const cap = parsePriceCap(field("input"), field("output"));
      if (!cap) return done(provider, { cap: model, capProblem: true }, { focus: `ci-${model}`, anchor: `#${rowAnchor(model)}`, keepCard: true });
      await savePriceCap(db, userId, provider, model, cap, now);
      return done(provider, { notice: { model, kind: "capped" } }, { focus: `t-${model}`, anchor: `#${rowAnchor(model)}`, keepCard: true });
    }
    case "refresh": {
      const account = await readAccountList(db, userId, provider);
      const snapshot = await currentSnapshot(db);
      const recent = (iso: string | undefined) => iso !== undefined && now.getTime() - Date.parse(iso) < REFRESH_GAP_MS;
      if (recent(account?.readAt) && recent(snapshot?.takenAt)) {
        const from = new Date(Math.max(Date.parse(account!.readAt), Date.parse(snapshot!.takenAt)) + REFRESH_GAP_MS).toISOString();
        return done(provider, {}, { flash: { problem: `The model list was read less than a minute ago. Refresh it again from ${hhmm(from)}.` }, keepCard: true });
      }
      await refreshCatalog(true);
      const read = await refreshAccountList(db, plugins, userId, provider, now);
      return done(provider, {}, { ...("problem" in read ? { flash: { problem: read.problem, details: read.details } } : {}), keepCard: true });
    }
    case "model-help": {
      // "Ask Admin for help" on a model's failed test: its name and the
      // plain reason only, never the provider's reply.
      if (viewer !== "friend") return new Response(null, { status: 403 });
      const reason = field("reason");
      if (!MODEL_HELP_REASONS.has(reason) || !model) return done(provider, {}, { flash: { problem: "There is nothing to ask about here." }, keepCard: true });
      const refused = { kind: "refused" as const, model, reason: reason as TestRefusal };
      const text = [refusalText(refused, plugin), refusalFix(refused, plugin)].filter(Boolean).join(" ");
      await db.prepare("INSERT INTO help_requests (user_id, item, reason, at) VALUES (?, ?, ?, ?)").bind(userId, `Test a model: ${model}`, text, now.toISOString()).run();
      return done(provider, {}, { flash: { said: "Sent to Admin: this item's name and its plain reason only." }, keepCard: true });
    }
    case "help": {
      // A friend asks Admin; the owner has no one above to ask.
      if (viewer !== "friend") return new Response(null, { status: 403 });
      const connected = isConnected(await readConnection(db, userId, provider), await readCheck(db, userId, provider));
      const ready = (await readReadyModels(db, plugins, userId)).some((m) => m.provider === provider);
      if (ready) return done(provider, {}, { flash: { problem: "There is nothing to ask about here." } });
      await db
        .prepare("INSERT INTO help_requests (user_id, item, reason, at) VALUES (?, ?, ?, ?)")
        .bind(userId, `Connect ${plugin.connect.guide.name}`, connected ? "connected, no model is ready yet" : "not connected yet", now.toISOString())
        .run();
      return done(provider, {}, { flash: { said: "Sent to Admin: this item's name and its plain reason only." } });
    }
  }
  return new Response(null, { status: 404 });
}
