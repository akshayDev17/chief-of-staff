// Models › Setup › Add a model, rendered on the server (design T02 / T17).
//
//   GET  /chief-of-staff/models/setup/add[?provider=<id>]
//   POST /chief-of-staff/models/setup/add/<id>/pick    model, and on Foundry its deployment name
//   POST /chief-of-staff/models/setup/add/<id>/help    friends only: "Ask Admin for help"
//
// One tab per connected provider. Its table lists every chat model the
// provider sells at a listed price, each with its region, list price,
// strength (the tier, worked out from that price) and source with its date
// read; there is nothing to type but Foundry's deployment name, filled in
// with the model ID. Pick runs the model's test call by itself; the result
// is three lines (the verdict, "<provider> replied:", the fix), shown only to
// the user who made the call. A model with no price yet says so and cannot
// be picked. Friend screens say "Admin" for the owner and never "deployment
// name" (design-v3 1.6).

import { CONTROLS_CSS, esc, nbDate, PAGE_CSS } from "../prices/page";
import { SOURCES } from "../prices/sources";
import type { Provider } from "../prices/types";
import { ADD_MODEL_PATH, BUDGETS_PATH, PROVIDERS_PATH, TASK_MODELS_PATH } from "../paths";
import { formatCost, type Viewer } from "../providers/page";
import { connectedProviders } from "../proxy/connections";
import type { PlainReason, PluginRegistry, ProviderPlugin } from "../proxy/plugin";
import { addModel, listOffer, refusalFix, refusalText, type AddOutcome, type AddRefusal, type OfferRow, type TestResult } from "./add";

export interface AddPageInput {
  viewer: Viewer;
  // The connected providers' plug-ins, in tab order.
  connected: ProviderPlugin[];
  selected?: ProviderPlugin;
  rows: OfferRow[];
  outcome?: AddOutcome;
  problem?: string;
  said?: string;
}

const tabHref = (provider: string): string => `${ADD_MODEL_PATH}?provider=${provider}`;
const action = (provider: string, verb: string): string => `${ADD_MODEL_PATH}/${provider}/${verb}`;

// Exact to the vendor's precision, at least two decimals: $0.125, $2.00.
const usd = (n: number): string => {
  const [whole, frac = ""] = String(Number(n.toPrecision(12))).split(".");
  return `$${whole}.${frac.padEnd(2, "0")}`;
};

const tokens = (u: TestResult["usage"]): string => {
  if (!u) return "";
  const input = u.input + u.cachedInput + u.cacheWrite + u.cacheWrite1h;
  return `${input} input and ${u.output} output tokens`;
};

function priceCells(row: OfferRow, plugin: ProviderPlugin): string {
  const region = `${esc(plugin.connect.locationLabel(row.location))}, chosen by ${row.locationSetBy === "user" ? "you" : "the app"}`;
  if (!row.price) {
    const waiting =
      plugin.provider === "foundry" && /^claude\b/i.test(row.model)
        ? esc("waiting for the maintainers' reading of its listing")
        : `not in ${esc(SOURCES[plugin.priceSource[0]!].label)} yet`;
    return `<td data-l="Region">–</td>
<td data-l="List price per million tokens"><span class="pill warn">no price yet</span></td>
<td data-l="Strength (from the price)">–</td>
<td data-l="Source">${waiting}</td>`;
  }
  const p = row.price;
  const stale = p.stale ? `<div class="small muted">last good price: its source failed at the latest refresh</div>` : "";
  return `<td data-l="Region">${region}</td>
<td data-l="List price per million tokens" class="num">${usd(p.input)} in · ${usd(p.output)} out</td>
<td data-l="Strength (from the price)">${row.tier ?? "–"}</td>
<td data-l="Source">${esc(SOURCES[p.source].label)}<div class="small muted">read ${nbDate(p.dateRead)}</div>${stale}</td>`;
}

function actionCell(row: OfferRow, plugin: ProviderPlugin, viewer: Viewer): string {
  if (!row.price) return `<td data-l=""><button type="button" class="btn small" disabled>Cannot be picked</button></td>`;
  if (!row.callable) {
    return `<td data-l=""><button type="button" class="btn small" disabled>Cannot be picked</button><div class="small muted">not offered yet: ${esc(plugin.connect.notCallableReason)}</div></td>`;
  }
  const label = row.added ? "Test again" : "Pick";
  const added = row.added ? `<span class="pill ok">added</span> ` : "";
  const id = `dep-${plugin.provider}-${row.model.replace(/[^A-Za-z0-9]+/g, "-")}`;
  const deployment =
    row.deployment !== undefined
      ? `<label class="small" for="${esc(id)}">${esc(viewer === "friend" ? "Foundry's name for the model" : "Deployment name")}</label>
<input class="f mono" id="${esc(id)}" name="deployment" value="${esc(row.deployment)}" required pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}" autocomplete="off" spellcheck="false">`
      : "";
  return `<td data-l=""><form method="post" action="${action(plugin.provider, "pick")}" class="pick">
<input type="hidden" name="model" value="${esc(row.model)}">${deployment}
<div class="row">${added}<button type="submit" class="btn small">${label}</button></div></form></td>`;
}

function table(input: AddPageInput, plugin: ProviderPlugin): string {
  if (!input.rows.length) return `<p class="small muted">The price table lists no chat model at ${esc(plugin.connect.guide.name)} yet.</p>`;
  const body = input.rows
    .map(
      (r) => `<tr${r.added ? ' class="added"' : ""}><td data-l="Model"><strong>${esc(r.model)}</strong></td>
${priceCells(r, plugin)}
${actionCell(r, plugin, input.viewer)}</tr>`,
    )
    .join("\n");
  return `<div class="tbl-wrap"><table class="stackable"><thead><tr><th>Model</th><th>Region</th><th>List price per million tokens</th><th>Strength (from the price)</th><th>Source</th><th></th></tr></thead>
<tbody>
${body}
</tbody></table></div>`;
}

function replyLine(plugin: ProviderPlugin, status: number, parts: Array<string | undefined>): string {
  const shown = [status === 200 ? "200 OK" : String(status), ...parts].filter(Boolean).map((p) => esc(p!));
  return `<p class="tc-reply">${esc(plugin.connect.guide.short)} replied: ${shown.join(" · ")}</p>`;
}

function outcomeBox(input: AddPageInput, plugin: ProviderPlugin): string {
  const o = input.outcome;
  if (!o) return "";
  if (o.kind === "added") {
    const t = o.model.test!;
    const named = t.repliedModel ? `reply names ${t.repliedModel}` : undefined;
    const spent = [tokens(t.usage), formatCost(t.costUsd)].filter(Boolean).join(" · ");
    return `<div class="tc tc-ok" role="status"><p class="tc-verdict"><strong>${esc(o.model.model)} added.</strong> Its test call ran by itself and passed.</p>
${replyLine(plugin, t.status, [`${t.modelId} (${plugin.connect.locationLabel(t.location)})`, named, t.text ? `“${t.text}”` : undefined])}
<p class="tc-fix small">${esc(spent)}. It is now one of your models for each task.</p></div>`;
  }
  const r = o.reply;
  const reply = r
    ? replyLine(plugin, r.status, r.repliedModel ? [`model ${r.repliedModel}`] : [r.errorName, r.message ? `“${r.message}”` : undefined])
    : o.note
      ? `<p class="tc-reply">${esc(o.note)}</p>`
      : "";
  const links = (o.links ?? [])
    .map((l) => `<a class="btn small secondary" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`)
    .join("");
  const help =
    input.viewer === "friend"
      ? `<form method="post" action="${action(plugin.provider, "help")}"><input type="hidden" name="model" value="${esc(o.model)}"><input type="hidden" name="reason" value="${esc(o.reason)}"><button type="submit" class="btn small help-btn">Ask Admin for help</button></form>`
      : "";
  const fix = refusalFix(o, plugin);
  return `<div class="tc tc-bad" role="alert"><p class="tc-verdict"><strong>${esc(refusalText(o, plugin, input.viewer))}</strong></p>
${reply}
${fix ? `<p class="tc-fix small">${esc(fix)}</p>` : ""}
${links || help ? `<div class="row">${links}${help}</div>` : ""}</div>`;
}

export function renderAddModelPage(input: AddPageInput): string {
  const plugin = input.selected;
  const tabs = input.connected
    .map((p) => {
      const on = p === plugin;
      return `<a href="${tabHref(p.provider)}"${on ? ' class="on" aria-current="page"' : ""}>${esc(p.connect.guide.name)}</a>`;
    })
    .join("");
  const foundryHint =
    plugin?.connect.deploymentName
      ? `<p class="hint small">${esc(input.viewer === "friend" ? "Foundry's name for the model" : "The deployment name")} is filled in for you with the model's ID. Change it only if you named it differently at Foundry.</p>`
      : "";
  const content = plugin
    ? `<nav class="row" aria-label="Providers" style="margin:10px 0"><span class="seg">${tabs}</span></nav>
${outcomeBox(input, plugin)}
${table(input, plugin)}
${foundryHint}`
    : `<div class="banner warn">Connect a provider first: its models are listed here once it is connected. <a href="${PROVIDERS_PATH}">Providers</a></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Models · Add a model · Chief of staff</title>
<style>${PAGE_CSS}${CONTROLS_CSS}${CSS}</style>
</head>
<body>
<main class="screen">
<h1>Models</h1>
<div class="subtabs"><span class="on">Setup</span><span aria-disabled="true">Usage</span></div>
<p class="small" style="margin:-4px 0 10px"><a href="${PROVIDERS_PATH}">Providers</a> · <a href="${BUDGETS_PATH}">Budgets</a> · <strong>Add a model</strong> · <a href="${TASK_MODELS_PATH}">Model for each task</a></p>
<h2>Add a model</h2>
<p>Pick from every chat model your provider sells at a listed price, of every model family. The price comes from the app's own price table, with its source and date; nothing to type. Each model's strength comes from its input price: Smallest under $0.50 per million tokens, Middle $0.50 to under $2.50, Strongest $2.50 and up.</p>
${input.problem ? `<div class="banner warn" role="alert">${esc(input.problem)}</div>` : ""}
${input.said ? `<div class="banner ok" role="status">${esc(input.said)}</div>` : ""}
${content}
<p class="small muted" style="margin-top:8px">A model can be picked only after its test call passes. A reply naming a different model is refused with a plain reason. A model with no price yet cannot be added, because the budget stop needs a real price. A model the app cannot call yet says "not offered yet" and why.</p>
<div class="row"><a class="btn" href="${TASK_MODELS_PATH}">Next: the model for each task</a></div>
</main>
</body>
</html>`;
}

const CSS = `
:root { --danger: #9b2c2c; --danger-soft: #fbe4e4; }
@media (prefers-color-scheme: dark) { :root { --danger: #f3a6a6; --danger-soft: #3a1f1f; } }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; max-width: 100%; }
.seg > a { padding: 4px 11px; color: var(--text); text-decoration: none; white-space: nowrap; }
.seg > a.on { background: var(--accent); color: var(--card); }
.seg > a:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
@media (max-width: 759px) {
  .seg { border: 0; border-radius: 0; gap: 6px; overflow: visible; }
  .seg > a { border: 1px solid var(--line); border-radius: 999px; }
}
td.num { white-space: nowrap; font-variant-numeric: tabular-nums; }
td[data-l="Model"] { white-space: nowrap; }
@media (max-width: 759px) { td[data-l="Model"] { white-space: normal; } }
form.pick { display: grid; gap: 4px; min-width: 12em; }
form.pick label { color: var(--muted); }
.pill.ok { background: var(--ok-soft); color: var(--ok); }
.btn.small { font-size: .85rem; min-height: 28px; padding: 3px 9px; }
.btn[disabled], .btn[aria-disabled] { opacity: .55; cursor: default; }
.help-btn { border-color: var(--line); background: var(--card); color: var(--text); }
.hint { color: var(--muted); margin: 6px 0 0; }
.tc { border: 1px solid var(--ok); border-radius: 10px; padding: 10px 12px; margin: 8px 0 10px; background: var(--ok-soft); }
.tc-bad { border-color: var(--danger); background: var(--danger-soft); }
.tc p { margin: 0 0 4px; }
.tc-reply { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .8rem; color: var(--muted); overflow-wrap: anywhere; }
.tc .row { margin-top: 6px; }
`;

const PROVIDER_ORDER: readonly Provider[] = ["bedrock", "foundry", "vertex"];

const ROUTE = new RegExp(`^${ADD_MODEL_PATH}(?:/([a-z]+)/(pick|help))?$`);

export const isAddModelPath = (pathname: string): boolean => ROUTE.test(pathname);

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

// The refusals a friend can ask Admin about, by the sentence they saw.
const HELP_REASONS: ReadonlySet<string> = new Set<AddRefusal | PlainReason>([
  "not_set_up", "not_allowed_yet", "switching_on", "no_such_model", "region_unavailable", "no_permission", "data_retention",
  "busy", "app_not_configured", "no_reply", "refused", "wrong_model", "bad_deployment", "budget_spent", "cannot_call", "no_price",
]);

// Every route is scoped to the signed-in user.
export async function handleAddModel(
  request: Request,
  input: { db: D1Database; plugins: PluginRegistry; userId: string; viewer: Viewer; now: Date },
): Promise<Response> {
  const { db, plugins, userId, viewer, now } = input;
  const url = new URL(request.url);
  const [, providerPart, verb] = ROUTE.exec(url.pathname) ?? [];
  const connectedIds = new Set(await connectedProviders(db, userId));
  const connected = PROVIDER_ORDER.filter((p) => plugins[p] && connectedIds.has(p)).map((p) => plugins[p]!);
  const page = async (selectedId: string | null | undefined, extra: { outcome?: AddOutcome; problem?: string; said?: string } = {}, status = 200) => {
    const selected = connected.find((p) => p.provider === selectedId) ?? connected[0];
    const rows = selected ? await listOffer(db, plugins, userId, selected.provider) : [];
    return html(renderAddModelPage({ viewer, connected, selected, rows, ...extra }), status);
  };

  if (!verb) return request.method === "GET" ? page(url.searchParams.get("provider")) : new Response(null, { status: 405 });
  const provider = providerPart as Provider;
  if (!plugins[provider]) return new Response(null, { status: 404 });
  if (request.method !== "POST") return new Response(null, { status: 405 });
  // A form posted from another site is refused.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return new Response(null, { status: 403 });
  const form = await request.formData();
  const field = (name: string): string => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };

  if (verb === "pick") {
    const deployment = form.has("deployment") ? field("deployment") : undefined;
    const outcome = await addModel(db, plugins, { userId, provider, model: field("model"), deployment, now });
    return page(provider, { outcome }, outcome.kind === "added" ? 200 : 400);
  }
  // "Ask Admin for help": the item's name and the plain reason only, never
  // the provider's reply.
  if (viewer !== "friend") return new Response(null, { status: 403 });
  const reason = field("reason");
  const model = field("model").slice(0, 120);
  if (!HELP_REASONS.has(reason) || !model) return page(provider, { problem: "There is nothing to ask about here." }, 400);
  const text = refusalText({ kind: "refused", model, reason: reason as AddRefusal }, plugins[provider], "friend");
  await db
    .prepare("INSERT INTO help_requests (user_id, item, reason, at) VALUES (?, ?, ?, ?)")
    .bind(userId, `Add a model: ${model}`, text, now.toISOString())
    .run();
  return page(provider, { said: "Sent to Admin: this item's name and its plain reason only." });
}
