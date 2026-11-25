// Models › Setup › Providers, rendered on the server (design T02 / T16): one
// "Connect <Provider>" button for every registered plug-in, each with its
// guide, its connection, its region, its monthly budget and its test call.
//
//   GET  /models/setup/providers[?provider=<id>][&disconnect=1][&change=region]
//   POST /models/setup/providers/<id>/connect | retry | region | disconnect | help
//   GET  /models/setup/providers/<id>/consented   (back from a consent page)
//
// Each test-call result is three lines: the plain verdict; "<provider>
// replied:" with the status, the error name and the provider's own message
// verbatim, in a smaller muted monospace font; then the fix with its buttons
// ([Open that page] [Try again], and [Ask Admin for help] on friend screens
// only). There is no table of failure messages: the plug-in's mapping picks
// the wording. The reply is shown only to the user who made the call.
// The Usage page, not built yet, is named but not linked.

import { ADD_MODEL_PATH, BUDGETS_PATH, PROVIDERS_PATH, TASK_MODELS_PATH } from "../paths";
import { CONTROLS_CSS, esc, nbDate, PAGE_CSS } from "../prices/page";
import type { Provider } from "../prices/types";
import { readBudget } from "../proxy/budgets";
import { readConnection } from "../proxy/connections";
import type { ConnectionFields, PluginRegistry, ProviderPlugin } from "../proxy/plugin";
import {
  askAdminForHelp,
  chooseRegion,
  connectProvider,
  disconnectProvider,
  finishConsent,
  readCheck,
  runCheck,
  verdictText,
  type Check,
  type CheckResult,
} from "./check";

// Who is looking: the owner, or a friend the owner invited (who says
// "Admin" for the owner and gets "Ask Admin for help").
export type Viewer = "owner" | "friend";

export interface ProviderPanel {
  plugin: ProviderPlugin;
  connection?: ConnectionFields;
  check?: Check;
  monthlyBudget?: number;
}

export interface ProvidersPageInput {
  viewer: Viewer;
  panels: ProviderPanel[];
  selected: Provider;
  confirmDisconnect: boolean;
  changeRegion: boolean;
  problem?: string;
  said?: string;
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

const statusText = (status: number): string => (status === 200 ? "200 OK" : String(status));

const linkButton = (href: string, label: string) =>
  `<a class="btn small secondary" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;

const postButton = (href: string, label: string, cls = "btn small", hidden = "") =>
  `<form method="post" action="${href}">${hidden}<button type="submit" class="${cls}">${esc(label)}</button></form>`;

function replyLine(result: CheckResult, plugin: ProviderPlugin): string {
  const { short } = plugin.connect.guide;
  const r = result.reply;
  if (!r) return result.note ? `<p class="tc-reply">${esc(result.note)}</p>` : "";
  if (result.verdict === "passed") {
    const text = r.text ? ` · “${esc(r.text)}”` : "";
    return `<p class="tc-reply">${esc(short)} replied: ${statusText(r.status)} · ${esc(result.modelId)} (${esc(plugin.connect.locationLabel(result.location))})${text}</p>`;
  }
  const parts = [statusText(r.status), r.errorName, r.message ? `“${r.message}”` : ""].filter(Boolean).map((p) => esc(p!));
  return `<p class="tc-reply">${esc(short)} replied: ${parts.join(" · ")}</p>`;
}

function resultBox(panel: ProviderPanel, viewer: Viewer): string {
  const { plugin, check } = panel;
  const result = check?.result;
  if (!result) {
    return `<div class="tc tc-sw" role="status"><p class="tc-verdict"><strong>Checking the connection…</strong></p>
<p class="tc-fix small">The test call runs by itself once the connection answers. This page refreshes by itself.</p></div>`;
  }
  const provider = plugin.provider;
  if (result.verdict === "passed") {
    const u = result.usage;
    const input = u ? u.input + u.cachedInput + u.cacheWrite + u.cacheWrite1h : 0;
    const spent = u ? `${input} input and ${u.output} output tokens · ${formatCost(result.costUsd ?? 0)} · ` : "";
    return `<div class="tc tc-ok" role="status"><p class="tc-verdict"><strong>Test call passed</strong> (ran by itself)</p>
${replyLine(result, plugin)}
<p class="tc-fix small">${spent}connected; a connection has no end date, and you get an alert at once if the grant is removed on the provider's side.</p></div>`;
  }
  const waiting = result.verdict === "switching_on" || result.reason === "budget_spent" || result.reason === "no_price";
  const next = check?.nextTryAt ? `Next try at ${hhmm(check.nextTryAt)} · you can move on to the next item.` : "";
  if (waiting) {
    // A spent budget can be raised on the Budgets page; Try again then calls at once.
    const retry = result.reason === "budget_spent" ? `\n<div class="row">${postButton(action(provider, "retry"), "Try again")}</div>` : "";
    return `<div class="tc tc-sw" role="status"><p class="tc-verdict"><strong>${esc(verdictText(result, plugin))}</strong></p>
${replyLine(result, plugin)}
<p class="tc-fix small">${next}</p>${retry}</div>`;
  }
  const polling = check?.state === "checking" && check.nextTryAt ? ` The app checks again every minute for an hour after Connect; next try at ${hhmm(check.nextTryAt)}.` : "";
  const links = (result.links ?? []).map((l) => linkButton(l.href, l.label)).join("");
  const help =
    viewer === "friend"
      ? postButton(action(provider, "help"), "Ask Admin for help", "btn help-btn small")
      : "";
  return `<div class="tc tc-bad" role="alert"><p class="tc-verdict"><strong>${esc(verdictText(result, plugin))}</strong></p>
${replyLine(result, plugin)}
<p class="tc-fix small">${esc(result.fix ?? "")}${esc(polling)}</p>
<div class="row">${links}${postButton(action(provider, "retry"), "Try again")}${help}</div></div>`;
}

function connectForm(panel: ProviderPanel): string {
  const { plugin, check } = panel;
  const c = plugin.connect;
  // A plug-in that opens the provider's own page (Bedrock's stack) opens it
  // in a new tab; this tab reloads to show the check.
  const opensNewTab = Boolean(c.setupLink);
  const fields = c.fields
    .map(
      (f) => `<label class="f" for="${plugin.provider}-${f.name}">${esc(f.label)}</label>
<input class="f mono" id="${plugin.provider}-${f.name}" name="${f.name}" placeholder="${esc(f.placeholder)}" required pattern="${esc(f.pattern)}" title="${esc(f.problem)}" autocomplete="off" spellcheck="false">`,
    )
    .join("\n");
  const waitingConsent = check?.pendingFields
    ? `<p class="small muted">Waiting for Microsoft's consent page: sign in there and tap Accept, or connect again.</p>`
    : "";
  return `${waitingConsent}<form method="post" action="${action(plugin.provider, "connect")}"${opensNewTab ? ' target="_blank" data-reload' : ""}>
${fields}
${c.grantHelp ? c.grantHelp() : ""}
<div class="row" style="margin-top:8px"><button type="submit" class="btn small">Connect ${esc(c.guide.name)}</button></div>
</form>`;
}

function regionLine(panel: ProviderPanel, changing: boolean): string {
  const { plugin, check } = panel;
  const c = plugin.connect;
  if (!c.guide.regionChoice || !check?.region) return "";
  const label = esc(c.locationLabel(check.region));
  const how =
    check.regionSetBy === "user"
      ? `${label}, chosen by you. The test call proves it.`
      : `chosen by the app from what your model supports: ${label}. The test call proves it.`;
  if (!changing) return `<p class="small" style="margin-top:8px"><strong>Region:</strong> ${how} <a href="${providerHref(plugin.provider, "&change=region")}">Change</a></p>`;
  const model = check.result?.model ?? c.testModel;
  const options = c
    .locations(model)
    .map((l) => `<option value="${esc(l)}"${l === check.region ? " selected" : ""}>${esc(c.locationLabel(l))}</option>`)
    .join("");
  return `<form class="row" method="post" action="${action(plugin.provider, "region")}" style="margin-top:8px">
<label class="small" for="${plugin.provider}-region"><strong>Region</strong> for ${esc(model)}</label>
<select class="f" id="${plugin.provider}-region" name="region" style="max-width:16em">${options}</select>
<button type="submit" class="btn small">Set and test</button> <a class="small" href="${providerHref(plugin.provider)}">Cancel</a>
</form>`;
}

function panelHtml(panel: ProviderPanel, input: ProvidersPageInput): string {
  const { plugin, connection, check } = panel;
  const g = plugin.connect.guide;
  const pages = g.pages.map((p) => `<a href="${esc(p.href)}" rel="noopener noreferrer">${esc(p.label)}</a>`).join(" · ");
  const head = `<p class="small muted">Guide checked on ${nbDate(g.checkedOn)} against the vendor's own pages · ${pages}</p>
<ol class="small">${g.steps.map((s) => `<li>${s}</li>`).join("")}</ol>`;
  if (!connection) return `${head}${connectForm(panel)}`;
  // "Connected" once the provider's side answers; until then the record is
  // stored and the check is waiting for the grant.
  const status =
    check?.state === "passed" || check?.state === "switching_on" ? "Connected" : check?.state === "revoked" ? "Removed on the provider's side" : "Connecting";
  const disconnect = `<p style="margin-top:8px"><strong>${status}</strong> <span class="pill ok">no key held</span> · <a class="btn small ghost" href="${providerHref(plugin.provider, "&disconnect=1")}">Disconnect</a></p>
<p class="small muted">To revoke it on the provider’s side: ${esc(g.revoke)}</p>`;
  const dialog = input.confirmDisconnect
    ? `<div class="dialog-backdrop"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="disc-title"><h2 id="disc-title">Disconnect ${esc(g.name)}?</h2>
<p class="small">Its models stop answering for you at once. To remove the grant on the provider’s side too: ${esc(g.revoke)}</p>
<div class="row" style="justify-content:flex-end"><a class="btn small ghost" href="${providerHref(plugin.provider)}">Cancel</a>${postButton(action(plugin.provider, "disconnect"), "Disconnect")}</div></div></div>`
    : "";
  const budget = `<p class="small"><strong>Monthly budget:</strong> ${panel.monthlyBudget ? `$${panel.monthlyBudget.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "not set yet"} · <a href="${BUDGETS_PATH}">Budgets</a></p>`;
  const template = check?.templateVersion ? `<p class="small muted">Stack template version ${esc(check.templateVersion)}.</p>` : "";
  const note =
    input.viewer === "friend"
      ? `<p class="small muted" style="margin-top:6px">Only you see the provider's reply. “Ask Admin for help” sends only this item's name and the plain reason.</p>`
      : "";
  const grantHelp = plugin.connect.grantHelp && check?.state !== "passed" ? plugin.connect.grantHelp(connection) : "";
  return `${head}${disconnect}${grantHelp}${dialog}${regionLine(panel, input.changeRegion)}${budget}${resultBox(panel, input.viewer)}${template}${note}`;
}

export function renderProvidersPage(input: ProvidersPageInput): string {
  const selected = input.panels.find((p) => p.plugin.provider === input.selected) ?? input.panels[0]!;
  const tabs = input.panels
    .map((p) => {
      const on = p === selected;
      const tick = p.check?.state === "passed" ? ' <span aria-label="connected">✓</span>' : "";
      return `<a href="${providerHref(p.plugin.provider)}"${on ? ' class="on" aria-current="page"' : ""}>Connect ${esc(p.plugin.connect.guide.name)}${tick}</a>`;
    })
    .join("");
  const recommended = input.panels.find((p) => p.plugin.connect.guide.recommendedForFriends);
  const intro =
    input.viewer === "friend"
      ? recommended
        ? `<p><span class="pill accent">Recommended for friends</span> ${esc(recommended.plugin.connect.guide.name)} has the fewest steps.</p>`
        : ""
      : `<p class="small muted">You connect all three; a friend usually connects one.</p>`;
  // Refresh while the check is waiting for the provider-side grant.
  const refresh = selected.check?.state === "checking" ? `<meta http-equiv="refresh" content="30">` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}
<title>Models · Providers · Chief of staff</title>
<style>${PAGE_CSS}${CONTROLS_CSS}${CSS}</style>
</head>
<body>
<main class="screen">
<h1>Models</h1>
<div class="subtabs"><span class="on">Setup</span><span aria-disabled="true">Usage</span></div>
<p class="small" style="margin:-4px 0 10px"><strong>Providers</strong> · <a href="${BUDGETS_PATH}">Budgets</a> · <a href="${ADD_MODEL_PATH}">Add a model</a> · <a href="${TASK_MODELS_PATH}">Model for each task</a></p>
<h2>Model providers</h2>
<p>Foundry, Bedrock and Vertex AI are the only providers. You never give the app a key: you let it call your models from inside your own account, and you can take that back there at any time.</p>
${intro}
${input.problem ? `<div class="banner warn" role="alert">${esc(input.problem)}</div>` : ""}
${input.said ? `<div class="banner ok" role="status">${esc(input.said)}</div>` : ""}
<section class="card">
<nav class="row" aria-label="Providers" style="margin-top:10px"><span class="seg">${tabs}</span></nav>
<div style="margin-top:10px">${panelHtml(selected, input)}</div>
</section>
<div class="row" style="margin-top:12px"><a class="btn" href="${ADD_MODEL_PATH}">Next: pick a model</a></div>
</main>
<script>
document.querySelectorAll("[data-copy]").forEach(function (b) {
  b.addEventListener("click", function () {
    if (navigator.clipboard) navigator.clipboard.writeText(b.getAttribute("data-copy")).then(function () { b.textContent = "Copied"; });
  });
});
document.querySelectorAll("form[data-reload]").forEach(function (f) {
  f.addEventListener("submit", function () { setTimeout(function () { location.reload(); }, 2000); });
});
</script>
</body>
</html>`;
}

const CSS = `
:root { --danger: #9b2c2c; --danger-soft: #fbe4e4; --accent-soft: #e2ecf6; }
@media (prefers-color-scheme: dark) { :root { --danger: #f3a6a6; --danger-soft: #3a1f1f; --accent-soft: #1d2a38; } }
.mono, .cmd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.cmd { font-size: .8rem; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
label.f { display: block; font-size: .85rem; margin: 8px 0 4px; }
.seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; max-width: 100%; }
.seg > a { padding: 4px 11px; color: var(--text); text-decoration: none; white-space: nowrap; }
.seg > a.on { background: var(--accent); color: var(--card); }
.seg > a:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
@media (max-width: 759px) {
  .seg { border: 0; border-radius: 0; gap: 6px; overflow: visible; }
  .seg > a { border: 1px solid var(--line); border-radius: 999px; }
}
.pill.ok { background: var(--ok-soft); color: var(--ok); }
.pill.accent { background: var(--accent-soft); color: var(--accent); }
.btn.small { font-size: .85rem; min-height: 28px; padding: 3px 9px; }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--line); }
.btn[aria-disabled] { opacity: .55; cursor: default; }
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
ol.small { padding-left: 20px; }
`;

const PROVIDER_ORDER: readonly Provider[] = ["bedrock", "foundry", "vertex"];

async function pageInput(
  db: D1Database,
  plugins: PluginRegistry,
  userId: string,
  viewer: Viewer,
  url: URL,
  now: Date,
  extra: { problem?: string; said?: string; selected?: Provider } = {},
): Promise<ProvidersPageInput> {
  const registered = PROVIDER_ORDER.filter((p) => plugins[p]);
  const panels = await Promise.all(
    registered.map(async (provider) => ({
      plugin: plugins[provider]!,
      connection: await readConnection(db, userId, provider),
      check: await readCheck(db, userId, provider),
      monthlyBudget: (await readBudget(db, userId, provider))?.monthlyUsd,
    })),
  );
  const asked = url.searchParams.get("provider");
  const selected = extra.selected ?? (registered.find((p) => p === asked) ?? (viewer === "friend" ? panels.find((p) => p.plugin.connect.guide.recommendedForFriends)?.plugin.provider : undefined) ?? registered[0]!);
  return {
    viewer,
    panels,
    selected,
    confirmDisconnect: url.searchParams.get("disconnect") === "1",
    changeRegion: url.searchParams.get("change") === "region",
    problem: extra.problem,
    said: extra.said,
    now,
  };
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const ROUTE = new RegExp(`^${PROVIDERS_PATH}(?:/([a-z]+)/(connect|retry|region|disconnect|help|consented))?$`);

export const isProvidersPath = (pathname: string): boolean => ROUTE.test(pathname);

// Every route is scoped to the signed-in user.
export async function handleProviders(
  request: Request,
  input: { db: D1Database; plugins: PluginRegistry; userId: string; viewer: Viewer; appOrigin: string | undefined; now: Date },
): Promise<Response> {
  const { db, plugins, userId, viewer, now } = input;
  const url = new URL(request.url);
  const [, providerPart, verb] = ROUTE.exec(url.pathname) ?? [];
  const page = async (extra: { problem?: string; said?: string; selected?: Provider } = {}, status = 200) =>
    html(renderProvidersPage(await pageInput(db, plugins, userId, viewer, url, now, extra)), status);
  const back = (provider: string) => Response.redirect(`${url.origin}${providerHref(provider)}`, 303);

  if (!verb) return request.method === "GET" ? page() : new Response(null, { status: 405 });
  const provider = providerPart as Provider;
  if (!plugins[provider]) return new Response(null, { status: 404 });

  if (verb === "consented") {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const outcome = await finishConsent(db, plugins, { userId, provider, returned: url.searchParams, now });
    if ("problem" in outcome) return page({ problem: outcome.problem, selected: provider }, 400);
    return back(provider);
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
      const typed = Object.fromEntries(plugins[provider]!.connect.fields.map((f) => [f.name, field(f.name)]));
      const outcome = await connectProvider(db, plugins, { userId, provider, typed, appOrigin: input.appOrigin, now });
      if ("problem" in outcome) return page({ problem: outcome.problem, selected: provider }, 400);
      return outcome.open ? Response.redirect(outcome.open, 303) : back(provider);
    }
    case "retry":
      await runCheck(db, plugins, userId, provider, now);
      return back(provider);
    case "region": {
      const problem = await chooseRegion(db, plugins, userId, provider, field("region"), now);
      return problem ? page({ problem, selected: provider }, 400) : back(provider);
    }
    case "disconnect":
      await disconnectProvider(db, userId, provider);
      return back(provider);
    case "help": {
      // A friend asks Admin; the owner has no one above to ask.
      if (viewer !== "friend") return new Response(null, { status: 403 });
      const sent = await askAdminForHelp(db, plugins, userId, provider, now);
      return page(sent ? { said: "Sent to Admin: this item's name and its plain reason only.", selected: provider } : { problem: "There is nothing to ask about here.", selected: provider }, sent ? 200 : 400);
    }
  }
  return new Response(null, { status: 404 });
}
