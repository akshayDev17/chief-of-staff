// The model table on Models › Setup › Providers (the owner, 2026-11-28: "we
// can simply keep the first test a model table"), the section the page opens
// at once the provider has authorized the app.
//
//   modelParts(input) -> Record<ModelPart, string>   the parts a request swaps in place
//   nextStep(state) -> Step | undefined              the one solid blue button
//   parseView(params) / viewQuery(provider, view)    what a request shows, as an address
//
// One table lists every model the provider lists with tool use
// (models/test-model.ts listOffer), each row in one state by the one rule
// (models/ready.ts rowState): Ready, Needs credit, or Needs a step. A Ready
// model is one the user's tasks can use with no test (the
// owner, 2026-11-28: "why would i as a user wanna waste my money on testing
// models i dont wish to test"); Test on a row stays, optional, and runs the
// model's test call once, its result under the row. Search matches any part
// of a model's name, maker or ID; the Maker filter, its own find box and its
// chips narrow the table; the Ready / Needs credit / Needs a step strip
// filters it too, over a bar of the true ratios, and counts only
// the rows search, the Maker filter and a strength show. Its cells add up to
// the list's own count. Needs credit carries Add credits, the provider's
// credits page. None of these sends a request: the page's script shows and
// hides rows, and recounts the strip.
//
// A row that needs a step has one action of its own: a model the account's
// settings leave out links those settings, then Check again reads the
// account's list; a router (priced per call by the model it picks) gets "Set
// price cap" (models/price-caps.ts). A row whose latest call failed, a task's
// own or a Test, reads "Failed when used" (or "Failed when tested") with its
// plain reason, and Try again in place of Test; it stays in its state.
//
// Exactly one button is solid app blue in any state, and it is the next step
// (the owner, 2026-11-28): Refresh model list while the list is stale, then
// Next: budgets; Use this cap while the cap editor is open; Connect when
// disconnected (page.ts). Everything else is outlined.
//
// Visible copy is the action lines; explanations sit in collapsed details.

import { BUDGETS_PATH, PROVIDERS_PATH } from "../paths";
import { esc } from "../prices/page";
import type { Dropped } from "../prices/openrouter";
import { makerKey, makerRowAttrs, nameMakers } from "../models/maker-filter";
import { strengthChip } from "../prices/tiers";
import { DEFAULT_CAP } from "../models/price-caps";
import { blockedReason, blockKind, MODEL_HELP_REASONS, refusalFix, refusalText, type Refused, type TestRefusal } from "../models/test-model";
import type { RowState, TableRow } from "../models/ready";
import type { TestRecord } from "../models/latest-tests";
import type { Link, ProviderPlugin } from "../proxy/plugin";

export type Viewer = "owner" | "friend";

// What a request shows beyond the stored state: a result under a row, a
// notice, the cap editor, the Disconnect confirm. Every one is an address
// (`viewQuery`), so a page without scripts reaches it by a link or a
// redirect, and the page's script fetches the same address in place.
export interface View {
  // The results under their rows, newest first: each test adds its own and
  // keeps the ones shown already, up to MAX_RESULTS. `reason`: a refusal that
  // records no call, made before any call or saying nothing about the model
  // (models/test-model.ts isVerdict), with the provider's `reply` where it gave one.
  results?: Array<{ model: string; reason?: TestRefusal; reply?: TestRecord["reply"] }>;
  notice?: { model: string; kind: "capped" | "allowed" | "left-out" };
  confirm?: "disconnect";
  cap?: string;
  capProblem?: boolean;
  disconnected?: boolean;
}

const NOTICE_KINDS = new Set(["capped", "allowed", "left-out"]);
export const MAX_RESULTS = 8;

// The provider's reply as a view carries it, kept only in its own shape.
function parseReply(text: string): TestRecord["reply"] {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.status !== "number") return undefined;
  const field = (k: string) => (typeof o[k] === "string" ? { [k]: o[k] as string } : {});
  return { status: o.status, ...field("errorName"), ...field("message"), ...field("repliedModel") };
}

export function parseView(params: URLSearchParams): View {
  const view: View = {};
  // Each `result` is a model, `<model>|<reason>`, or `<model>|<reason>|<reply as JSON>`.
  const results = params.getAll("result").filter(Boolean).slice(0, MAX_RESULTS).map((r) => {
    const [model, reason, ...reply] = r.split("|");
    const parsed = reply.length ? parseReply(reply.join("|")) : undefined;
    return { model: model!, ...(reason ? { reason: reason as TestRefusal } : {}), ...(reason && parsed ? { reply: parsed } : {}) };
  });
  if (results.length) view.results = results;
  const notice = params.get("notice");
  const kind = params.get("kind") ?? "";
  if (notice && NOTICE_KINDS.has(kind)) view.notice = { model: notice, kind: kind as NonNullable<View["notice"]>["kind"] };
  if (params.get("confirm") === "disconnect") view.confirm = "disconnect";
  const cap = params.get("cap");
  if (cap) view.cap = cap;
  if (params.get("cap-problem") === "1") view.capProblem = true;
  if (params.get("disconnected") === "1") view.disconnected = true;
  return view;
}

export function viewQuery(provider: string, view: View): string {
  const q = new URLSearchParams({ provider });
  for (const r of view.results ?? []) q.append("result", r.reason ? `${r.model}|${r.reason}${r.reply ? `|${JSON.stringify(r.reply)}` : ""}` : r.model);
  if (view.notice) {
    q.set("notice", view.notice.model);
    q.set("kind", view.notice.kind);
  }
  if (view.confirm) q.set("confirm", view.confirm);
  if (view.cap) q.set("cap", view.cap);
  if (view.capProblem) q.set("cap-problem", "1");
  if (view.disconnected) q.set("disconnected", "1");
  return q.toString();
}

export type Step = "connect" | "cap" | "refresh" | "next";

// The one solid blue button: the next step.
export function nextStep(state: { connected: boolean; view: View; catalogCurrent: boolean }): Step {
  if (!state.connected) return "connect";
  if (state.view.cap) return "cap";
  if (!state.catalogCurrent) return "refresh";
  return "next";
}

export interface ModelsTableInput {
  plugin: ProviderPlugin;
  viewer: Viewer;
  // Every row of the model list, each with its state (models/ready.ts readTable).
  rows: TableRow[];
  // The provider's list as read, whether it follows the current rules, the
  // entries dropped from it before anything reads it, and how many it lists
  // with no tool use (never in the table).
  catalog?: { readAt: string; current: boolean; dropped?: Dropped; noToolUse: number };
  // For a failed result under a row: the tasks whose saved main model it is,
  // each with the fallback its calls fall to when it fails, where it has one.
  usedBy: Map<string, Array<{ task: string; fallback?: string }>>;
  view: View;
  step?: Step;
  // A problem from the last request, shown above the table.
  problem?: { text: string; details?: string };
  now: Date;
}

export type ModelPart = "err" | "strip" | "head" | "rows" | "foot";

const action = (provider: string, verb: string): string => `${PROVIDERS_PATH}/${provider}/${verb}`;
const viewHref = (provider: string, view: View, anchor = ""): string => `${PROVIDERS_PATH}?${viewQuery(provider, view)}${anchor}`;
const hhmm = (iso: string): string => `${iso.slice(11, 16)} UTC`;
// "09:49 UTC", or with its date when it is not today's.
const stamp = (iso: string, now: Date): string => (iso.slice(0, 10) === now.toISOString().slice(0, 10) ? hhmm(iso) : `${hhmm(iso)} on ${iso.slice(0, 10)}`);
export const rowAnchor = (model: string): string => `m-${model.replace(/[^A-Za-z0-9]+/g, "-")}`;

// Exact to the vendor's precision, at least two decimals: $0.125, $2.00.
export const usd = (n: number): string => {
  const [whole, frac = ""] = String(Number(n.toPrecision(12))).split(".");
  return `$${whole}.${frac.padEnd(2, "0")}`;
};

export const formatCost = (n: number): string => {
  if (n === 0) return "$0";
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return n < 0.0001 ? "under $0.0001" : `$${n.toFixed(4)}`;
};

const joinAnd = (a: string[]): string => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a.at(-1)}`);

export const ICON = {
  ok: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m3 8.5 3.2 3L13 4.5"/></svg>',
  bad: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6v4.2M8 11.2v.2"/></svg>',
  chev: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg>',
  x: '<svg viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg>',
  play: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z"/></svg>',
  redo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3"/></svg>',
  cap: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 2.5h10M8 5v9.5M10.4 7.3c-.4-.8-1.2-1.2-2.4-1.2-1.3 0-2.2.7-2.2 1.6 0 2.3 4.8 1.2 4.8 3.6 0 1-1 1.7-2.5 1.7-1.2 0-2.2-.5-2.6-1.3"/></svg>',
  search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="5"/><path d="m11 11 3.5 3.5"/></svg>',
};

const newTab = (l: Link, cls: string): string => `<a class="${cls}" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`;

const shortName = (r: TableRow): string => {
  const n = r.name ?? r.model;
  return n.includes(": ") ? n.slice(n.indexOf(": ") + 2) : n;
};

// ---------- the one rule for what a row shows ----------

// What a row is made of: its state (models/ready.ts rowState, the one rule
// the strip, its filters and the task dropdowns share); its latest call on
// the current key; and this page's own Test of it, carried in the view: a
// refusal that recorded nothing (`refusal`), or a recorded result (`tested`).
export interface RowFacts {
  state: RowState;
  latest?: { state: "passed" | "failed"; result: TestRecord };
  tested?: boolean;
  refusal?: TestRecord;
}
export type RowAction = "credits" | "test-again" | "budgets";
export type RowTag = "needs-credit" | "busy" | "couldnt-test";

// One record as the row shows it, with the actions that answer it.
export interface Shown {
  result: TestRecord;
  actions: RowAction[];
}

// What the row shows: `state` for the strip and the filters; its tag; `lead`,
// the failure its reason line and its result lead with; `failed`, how its
// latest call failed ("used" by a task, or "tested"); `passed`, a result
// that says this Test passed; `ask`, the reason a friend's Ask Admin sends,
// only a reason the model-help form takes (MODEL_HELP_REASONS).
export interface RowView {
  state: RowState;
  tag?: RowTag;
  lead?: Shown;
  failed?: "used" | "tested";
  passed: boolean;
  ask?: TestRefusal;
}

const actionsFor = (r: TestRecord): RowAction[] =>
  r.reason === "no_credits" ? ["credits"] : r.reason === "busy" ? ["test-again"] : r.reason === "budget_spent" ? ["budgets"] : [];
const shownOf = (result: TestRecord): Shown => ({ result, actions: actionsFor(result) });
const askable = (reason: TestRefusal | undefined): TestRefusal | undefined => (reason && MODEL_HELP_REASONS.has(reason) ? reason : undefined);

// This page's refusal that recorded nothing leads, with a tag on a row that
// is otherwise Ready; else a failed latest call leads, as Failed when used
// (or tested), on a row nothing blocks. A Needs credit row says so in a tag.
export function describeRow(f: RowFacts): RowView {
  const { state } = f;
  if (f.refusal) {
    const reason = f.refusal.reason;
    const tag: RowTag | undefined = reason === "no_credits" ? "needs-credit" : state !== "ready" ? undefined : reason === "busy" ? "busy" : "couldnt-test";
    const ask = askable(reason);
    return { state, ...(tag ? { tag } : {}), lead: shownOf(f.refusal), passed: false, ...(ask ? { ask } : {}) };
  }
  const tag = state === "credit" ? { tag: "needs-credit" as const } : {};
  if (state !== "step" && f.latest?.state === "failed") {
    const ask = askable(f.latest.result.reason);
    return { state, ...tag, lead: shownOf(f.latest.result), failed: f.latest.result.used ? "used" : "tested", passed: false, ...(ask ? { ask } : {}) };
  }
  return { state, ...tag, passed: Boolean(f.tested && f.latest?.state === "passed") };
}

// The facts of `r`'s row, from its state and the view.
function rowFacts(r: TableRow, input: ModelsTableInput): RowFacts {
  const res = input.view.results?.find((x) => x.model === r.model);
  const latest = r.latest ? { state: r.latest.state, result: r.latest.result } : undefined;
  let refusal: TestRecord | undefined;
  if (res?.reason) {
    const refused: Refused = { kind: "refused", model: r.model, reason: res.reason, ...(r.free ? { free: true } : {}) };
    const fix = refusalFix(refused, input.plugin);
    refusal = { reason: res.reason, text: refusalText(refused, input.plugin), ...(fix ? { fix } : {}), ...(res.reply ? { reply: res.reply } : {}) };
  }
  return { state: r.state, ...(latest ? { latest } : {}), ...(res && !res.reason ? { tested: true } : {}), ...(refusal ? { refusal } : {}) };
}

const primaryIf = (input: ModelsTableInput, step: Step): string => (input.step === step ? "primary" : "outline");

export type StripCounts = Record<RowState, number> & { total: number };

// The strip's counts, by rowState, the rule the task dropdowns follow too.
// Each row carries its rowState as data-state, and the page's script sums
// those over the rows the search, the Maker filter and a strength show
// (page-script.ts), so the strip counts the view; these whole-list counts are
// what it shows unfiltered, and without the script. Ready + Needs credit +
// Needs a step = the total, the list's own count.
export function stripCounts(rows: Pick<TableRow, "state">[]): StripCounts {
  const n: StripCounts = { ready: 0, credit: 0, step: 0, total: rows.length };
  for (const r of rows) n[r.state]++;
  return n;
}

// ---------- the strip: counts that filter the table ----------

// The words of the bar's label; the page's script writes the same words.
export const barLabel = (c: StripCounts, narrowed = false): string =>
  `${c.ready} of ${c.total}${narrowed ? " shown" : ""} ready: ${c.credit} need credit, ${c.step} need a step`;

export const STRIP_CELLS: ReadonlyArray<readonly [RowState, string, string]> = [
  ["ready", "Ready", "good"],
  ["credit", "Needs credit", "warn"],
  ["step", "Needs a step", ""],
];

function stripPart(input: ModelsTableInput): string {
  const c = stripCounts(input.rows);
  const cell = (key: RowState, label: string, tone: string) =>
    `<button type="button" class="cell" data-filter="${key}" data-k="cell-${key}" aria-pressed="false"><span class="l">${label}</span><span class="v num${c[key] && tone ? ` ${tone}` : ""}">${c[key]}</span></button>`;
  // Needs credit carries its answer: the provider's credits page, shown while
  // any model in view needs credit (the page's script follows the view).
  const credits = input.plugin.connect.guide.credits;
  const add = credits ? `<a class="cell-act ext" href="${esc(credits.href)}" target="_blank" rel="noopener noreferrer" data-credit-act${c.credit ? "" : " hidden"}>${esc(credits.label)}</a>` : "";
  const cells = STRIP_CELLS.map(([key, label, tone]) => (key === "credit" ? `<div class="cellx">${cell(key, label, tone)}${add}</div>` : cell(key, label, tone))).join("");
  const pct = (n: number) => (c.total ? (n / c.total) * 100 : 0).toFixed(3);
  return `<div class="strip" role="group" aria-label="Show models">${cells}</div>
<div class="bar" role="img" aria-label="${barLabel(c)}"><i class="w" style="width:${pct(c.ready)}%"></i><i class="c" style="width:${pct(c.credit)}%"></i></div>
<div class="ends num"><span>0</span><span data-ends>${c.total} models</span></div>`;
}

// ---------- the list head: where the list is from, and Refresh ----------

function refreshForm(input: ModelsTableInput, label: string, cls: string, k: string): string {
  const short = esc(input.plugin.connect.guide.short);
  return `<form method="post" action="${action(input.plugin.provider, "refresh")}" data-fetch data-busy-list class="inline"><button type="submit" class="${cls}" data-k="${k}" data-busy="Reading ${short}'s list…">${label}</button></form>`;
}

function headPart(input: ModelsTableInput): string {
  const { plugin } = input;
  const short = esc(plugin.connect.guide.short);
  const read = input.catalog ? esc(stamp(input.catalog.readAt, input.now)) : "not yet";
  // A <div>, not a <p>: a form inside a <p> ends the paragraph.
  return `<div class="src"><span><span class="w">From ${short}, read</span><span class="n">Read</span> ${read}</span> · ${refreshForm(input, "Refresh", "link", "refresh")}</div><p class="unit">In / out per M tokens</p>`;
}

// A problem from the last request; and a list stored under older rules,
// which waits for a fresh read: the next step.
function errPart(input: ModelsTableInput): string {
  const p = input.problem;
  const short = esc(input.plugin.connect.guide.short);
  const stale = input.catalog && !input.catalog.current
    ? `<div class="stale" role="status"><p>This list follows older rules. Read ${short}'s list again.</p>${refreshForm(input, "Refresh model list", `btn ${primaryIf(input, "refresh")} small`, "refresh-list")}</div>`
    : "";
  if (!p) return stale;
  const details = p.details ? `<details><summary>Details</summary><p class="small">${esc(p.details)}</p></details>` : "";
  return `<div class="err" role="alert">${ICON.bad}<div><p>${esc(p.text)}</p>${details}</div></div>${stale}`;
}

// ---------- the rows ----------

const TAGS: Record<RowTag, string> = {
  "needs-credit": '<span class="pill warn">Needs credit</span>',
  busy: '<span class="pill">Busy</span>',
  "couldnt-test": `<span class="pill">Couldn't test</span>`,
};

// "Failed when used" (a task's own call) or "Failed when tested" (a Test).
const failedWord = (v: RowView): string => (v.failed === "used" ? "Failed when used" : "Failed when tested");

function priceHtml(r: TableRow, input: ModelsTableInput): string {
  const p = input.plugin.provider;
  if (blockKind(r) === "router") {
    return `<span class="price capcell"><a class="btn small outline capbtn" href="${esc(viewHref(p, { cap: r.model }, `#${rowAnchor(r.model)}`))}" data-view data-k="co-${esc(r.model)}" aria-label="Set price cap for ${esc(shortName(r))}" title="Set a price cap so it can be used">${ICON.cap}<span>Set price cap</span></a></span>`;
  }
  if (r.cap) return `<span class="price num" title="Price cap">≤ ${usd(r.cap.input)} / ${usd(r.cap.output)}</span>`;
  if (!r.price) return '<span class="price dash" aria-label="no price">–</span>';
  return `<span class="price num">${usd(r.price.input)} / ${usd(r.price.output)}</span>`;
}

// The row's strength chip (prices/tiers.ts strengthChip), none for a router
// with no cap yet.
function chipOf(r: TableRow): string {
  if (blockKind(r) === "router") return "";
  return strengthChip({ tier: r.tier, input: r.price?.input, output: r.price?.output, free: r.free }) ?? "";
}

const BLOCK_TITLE: Record<string, string> = {
  router: "Set a price cap first",
  account: "Allow it in your account settings first",
  not_callable: "The app can't call it",
  no_price: "No price yet",
};

function rowActions(r: TableRow, input: ModelsTableInput): string {
  const { plugin } = input;
  const p = plugin.provider;
  const id = esc(r.model);
  const name = esc(shortName(r));
  const kind = blockKind(r);
  // Try again on a row whose latest call failed: the same one test call.
  const again = !kind && r.latest?.state === "failed";
  const title = kind ? BLOCK_TITLE[kind]! : again ? "Try it again now: one test call" : "Optional: one test call now";
  const test = `<form method="post" action="${action(p, "test")}" data-fetch class="inline"><input type="hidden" name="model" value="${id}"><button type="submit" class="btn tbtn${again ? " again" : ""}" data-k="t-${id}" data-busy="${again ? "Trying…" : "Testing…"}" title="${esc(title)}" aria-label="${again ? "Try again" : "Test"} ${name}"${kind ? " disabled" : ""}><span class="ico">${again ? ICON.redo : ICON.play}</span><span class="lbl">${again ? "Try again" : "Test"}</span></button></form>`;
  return `<span class="acts-row">${test}</span>`;
}

// A row the account's settings leave out: its reason, a labelled link to
// those settings, then Check again, which reads the account's list in place.
function leftOutMeta(r: TableRow, input: ModelsTableInput): string {
  const { plugin } = input;
  const id = esc(r.model);
  const name = esc(shortName(r));
  const short = esc(plugin.connect.guide.short);
  const settings = plugin.connect.guide.accountSettings;
  const checked = input.view.notice?.model === r.model && input.view.notice.kind === "left-out";
  const allow = settings
    ? `<a class="link ext" href="${esc(settings.href)}" target="_blank" rel="noopener noreferrer" data-allow="${id}" data-k="al-${id}" aria-label="Allow in settings: ${name}, in ${esc(settings.label)}"${checked ? " hidden" : ""}>Allow in settings</a>`
    : "";
  const check = `<form method="post" action="${action(plugin.provider, "check-account")}" data-fetch class="inline" data-check-for="${id}"${checked || !settings ? "" : " hidden"}><input type="hidden" name="model" value="${id}"><button type="submit" class="link" data-k="ac-${id}" data-busy="Checking…" aria-label="Check again whether ${name} is allowed">Check again</button></form>`;
  return `<span class="meta left" title="${esc(blockedReason(r, plugin) ?? "")}">Your ${short} settings leave it out · ${allow}${check}</span>`;
}

// "OpenRouter replied: 404 · Not Found · “No endpoints found …”", escaped.
function replyText(plugin: ProviderPlugin, reply: TestRecord["reply"]): string {
  if (!reply) return "";
  const parts = [reply.status === 200 ? "200 OK" : String(reply.status), reply.repliedModel ? `model ${reply.repliedModel}` : undefined, reply.errorName, reply.message ? `“${reply.message}”` : undefined].filter(Boolean);
  return `${esc(plugin.connect.guide.short)} replied: ${esc(parts.join(" · "))}`;
}

// A record's reply, fix and links, for Details; `omit` is a link shown as a button.
function detailParts(plugin: ProviderPlugin, r: TestRecord, omit: string | undefined): string[] {
  const links = (r.links ?? []).filter((l) => l.href !== omit).map((l) => newTab(l, "ext")).join(" · ");
  return [r.reply ? replyText(plugin, r.reply) : "", r.fix ? esc(r.fix) : "", links].filter(Boolean);
}

// The result under a row: the lead's plain line and its actions, the
// provider's own words collapsed.
function resultHtml(r: TableRow, input: ModelsTableInput, v: RowView): string {
  const { plugin } = input;
  const p = plugin.provider;
  const hide = `<button type="button" class="link hide" data-hide="${esc(r.model)}">Hide</button>`;
  if (v.passed) return `<div class="result ok" role="status"><p class="v">${ICON.ok}<span><strong>${esc(shortName(r))} passed.</strong> It answered just now.</span>${hide}</p></div>`;
  if (!v.lead) return "";
  const credits = plugin.connect.guide.credits;
  const ACTION: Record<RowAction, string> = {
    credits: credits ? newTab(credits, "btn small outline ext") : "",
    "test-again": `<form method="post" action="${action(p, "test")}" data-fetch class="inline"><input type="hidden" name="model" value="${esc(r.model)}"><button type="submit" class="btn small outline" data-k="again-${esc(r.model)}" data-busy="Testing…">Test again</button></form>`,
    budgets: `<a class="btn small outline" href="${BUDGETS_PATH}">Budgets</a>`,
  };
  const ask =
    input.viewer === "friend" && v.ask
      ? `<form method="post" action="${action(p, "model-help")}" data-fetch class="inline"><input type="hidden" name="model" value="${esc(r.model)}"><input type="hidden" name="reason" value="${esc(v.ask)}"><button type="submit" class="btn small outline" data-k="help-${esc(r.model)}">Ask Admin for help</button></form>`
      : "";
  const actsHtml = v.lead.actions.map((a) => ACTION[a]).join("") + ask;
  const acts = actsHtml ? `<div class="acts">${actsHtml}</div>` : "";
  const usedBy = v.failed ? (input.usedBy.get(r.model) ?? []) : [];
  const none = usedBy.filter((u) => !u.fallback).map((u) => u.task);
  const used = [
    ...usedBy.flatMap((u) => (u.fallback ? [`<p>${esc(u.task)} falls to ${esc(u.fallback)} when it fails.</p>`] : [])),
    none.length ? `<p>${esc(joinAnd(none))} ${none.length === 1 ? "has" : "have"} no fallback.</p>` : "",
  ].join("");
  const det = detailParts(plugin, v.lead.result, credits?.href).map((d) => `<p>${d}</p>`).join("");
  const cls = v.lead.result.reason === "no_credits" ? "warn" : "bad";
  const head = v.failed ? `${failedWord(v)} · ${v.lead.result.text}` : v.lead.result.text;
  return `<div class="result ${cls}" role="alert"><p class="v">${ICON.bad}<span><strong>${esc(head)}</strong></span>${hide}</p>${used}${acts}${det ? `<details><summary>Details</summary>${det}</details>` : ""}</div>`;
}

function capEditor(r: TableRow, input: ModelsTableInput): string {
  const p = input.plugin.provider;
  const c = r.cap ?? DEFAULT_CAP;
  const id = esc(r.model);
  const short = esc(input.plugin.connect.guide.short);
  const problem = input.view.capProblem ? `<p class="cap-err" role="alert">Enter two prices above $0, each at most $1000.</p>` : "";
  return `<div class="capbox" role="group" aria-label="Price cap for ${esc(shortName(r))}">
<p><strong>Cap what one call may cost.</strong> ${short} then routes only to models at or under these prices, with no fee per search or per request.</p>${problem}
<form method="post" action="${action(p, "cap")}" data-fetch><input type="hidden" name="model" value="${id}">
<div class="capf"><label>In $<input type="number" name="input" inputmode="decimal" min="0.01" max="1000" step="0.01" required value="${c.input.toFixed(2)}" data-k="ci-${id}" data-keep data-autofocus aria-label="Input price cap, dollars per million tokens"></label><label>Out $<input type="number" name="output" inputmode="decimal" min="0.01" max="1000" step="0.01" required value="${c.output.toFixed(2)}" data-k="cx-${id}" data-keep aria-label="Output price cap, dollars per million tokens"></label><span class="u">per M tokens</span></div>
<div class="acts"><button type="submit" class="btn ${primaryIf(input, "cap")} small" data-k="cs-${id}">Use this cap</button><a class="link" href="${esc(viewHref(p, {}, `#${rowAnchor(r.model)}`))}" data-view data-k="cc-${id}">Cancel</a></div>
</form></div>`;
}

function noticeHtml(r: TableRow, input: ModelsTableInput): string {
  const n = input.view.notice!;
  const hide = `<button type="button" class="link hide" data-hide="">Hide</button>`;
  if (n.kind === "left-out") {
    return `<div class="result warn" role="status"><p class="v">${ICON.bad}<span>Your ${esc(input.plugin.connect.guide.short)} settings still leave it out.</span>${hide}</p></div>`;
  }
  const ready = r.state === "ready" ? " It's ready for tasks." : r.state === "credit" ? " It needs credit." : "";
  const text = n.kind === "capped" && r.cap ? `Capped at ${usd(r.cap.input)} / ${usd(r.cap.output)} per M tokens.${ready}` : `Now allowed for your account.${ready}`;
  return `<div class="result ok" role="status"><p class="v">${ICON.ok}<span>${esc(text)}</span>${hide}</p></div>`;
}

function rowHtml(r: TableRow, input: ModelsTableInput, makerNames: Map<string, string>): string {
  const { plugin, view } = input;
  const p = plugin.provider;
  const v = describeRow(rowFacts(r, input));
  const kind = blockKind(r);
  const makerId = makerKey(r.model);
  const maker = makerNames.get(makerId) ?? makerId;
  const name = shortName(r);
  const id = esc(r.model);
  const anchor = rowAnchor(r.model);
  // A tag only where it says something: a Ready row carries none (a status
  // on hundreds of rows says nothing); the strip's Ready cell finds them.
  let tags = "";
  if (r.free) tags += '<span class="pill free">Free</span>';
  if (v.tag) tags += TAGS[v.tag];
  const resultHere = view.results?.some((x) => x.model === r.model) ?? false;
  const plainMeta = `<span class="meta"><span data-hl>${esc(maker)}</span> · <span data-hl>${id}</span></span>`;
  let meta: string;
  if (kind === "account") meta = leftOutMeta(r, input);
  else if (kind === "router") meta = `<span class="meta">Priced per call by the model it picks</span>`;
  else if (kind === "not_callable") meta = `<span class="meta" title="${esc(plugin.connect.notCallableReason(r.model))}">Can't be called · ${esc(plugin.connect.notCallableReason(r.model))}</span>`;
  else if (kind === "no_price") meta = `<span class="meta">No price yet · <span data-hl>${id}</span></span>`;
  else if (r.cap && !v.lead) {
    // Only the maker and ID clip; Change cap always shows whole, even on a phone.
    meta = `<span class="meta capped"><span class="clip"><span data-hl>${esc(maker)}</span> · <span data-hl>${id}</span> · capped</span><span class="cg">&nbsp;· <a class="link" href="${esc(viewHref(p, { cap: r.model }, `#${anchor}`))}" data-view data-k="cg-${id}">Change cap</a></span></span>`;
  } else if (v.lead && !resultHere) {
    const lead = v.failed ? `<span class="fw">${failedWord(v)}</span> · ${esc(v.lead.result.text)}` : esc(v.lead.result.text);
    meta = `<span class="meta why">${lead} · <button type="button" class="link" data-det="${esc(anchor)}" aria-expanded="false" aria-controls="det-${esc(anchor)}">Details</button></span>`;
  } else meta = plainMeta;
  let extra = "";
  if (view.cap === r.model && r.router) extra = capEditor(r, input);
  else if (view.notice?.model === r.model) extra = noticeHtml(r, input);
  else if (resultHere) extra = resultHtml(r, input, v);
  else if (v.lead) {
    const omit = plugin.connect.guide.credits?.href;
    const det = [`${esc(maker)} · ${id}`, ...detailParts(plugin, v.lead.result, omit)].map((d) => `<span>${d}</span>`).join("");
    extra = `<div class="det" id="det-${esc(anchor)}" data-det-panel hidden>${det}</div>`;
  }
  const hay = esc(`${r.name ?? ""} ${name} ${maker} ${makerId} ${r.model}`.toLowerCase());
  return `<li class="row" id="${esc(anchor)}" data-id="${id}"${makerRowAttrs(r.model, maker)} data-hay="${hay}" data-state="${v.state}" data-strength="${esc(chipOf(r))}"${kind ? " data-blocked" : ""}><span class="nm"><span class="t" data-hl>${esc(name)}</span>${tags}</span>${meta}${priceHtml(r, input)}<span class="tier">${esc(chipOf(r))}</span>${rowActions(r, input)}${extra ? `<div class="more">${extra}</div>` : ""}</li>`;
}

function rowsPart(input: ModelsTableInput): string {
  if (!input.rows.length) {
    return `<li class="empty"><p>No model is listed yet. Refresh reads ${esc(input.plugin.connect.guide.short)}'s list now.</p></li>`;
  }
  const { plugin } = input;
  const makerNames = nameMakers(input.rows.map((r) => ({ id: r.model, ...(r.name ? { name: r.name } : {}) })), { key: plugin.provider, name: plugin.connect.guide.name });
  return input.rows.map((r) => rowHtml(r, input, makerNames)).join("\n");
}

// ---------- the list foot: what the list is, collapsed ----------

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function footPart(input: ModelsTableInput): string {
  const short = esc(input.plugin.connect.guide.short);
  const d = input.catalog?.dropped;
  const noTools = input.catalog?.noToolUse ?? 0;
  const tools = noTools ? ` It also leaves out ${counted(noTools, "model that lists no tool use", "models that list no tool use")}: a task's agent calls tools.` : "";
  const dropped = d
    ? `<li>Every model ${short} lists is here but the ones no task can use: ${counted(d.batch, "“:batch” variant", "“:batch” variants")} (they answer no chat call), ${counted(d.alias, "“~” alias", "“~” aliases")} (each points to a model listed under its own ID), ${counted(d.router, "router no price cap can bound", "routers no price cap can bound")} (a panel of models, or another maker's router) and ${counted(d.unusable ?? 0, "model that gives audio, images or video, gives no text, or lists no price", "models that give audio, images or video, give no text, or list no price")}.${tools}</li>`
    : `<li>Every model ${short} lists is here.${tools}</li>`;
  const terms = input.plugin.connect.freeModelTerms;
  const free = terms && input.rows.some((r) => r.free)
    ? `<li>Free models work without credit. ${esc(terms.text)} ${terms.links.map((l) => newTab(l, "ext")).join(" · ")}</li>`
    : "";
  return `<details><summary>About this list</summary><ul>
${dropped}
<li>Ready needs no test: your ${short} account's own list has the model, nothing blocks it, and it is free or your account has credit. Tasks choose among the Ready models.</li>
<li>Credit is the account line's: credit bought, and the key's limit not used up. Add credits on ${short} and its paid models are Ready on your next visit.</li>
<li>Test is optional: one call, to see a model answer now. A failed call, a task's own or a test's, marks its row until a later call works, and the model stays Ready; Try again tests it once.</li>
<li>A model your ${short} settings leave out links those settings; Check again reads your account's list.</li>
<li>A router priced per call by the model it picks takes a price cap, which gives it a price the budget stop can use: ${short} then picks only models at or under the cap, and none with a fee per search or per request.</li>
<li>Strength comes from the input price per million tokens: Smallest under $0.50, Middle to $2.50, Strongest above.</li>
<li>Free: gives only text and costs $0 on every price ${short} lists.</li>
${free}
</ul></details>`;
}

export function modelParts(input: ModelsTableInput): Record<ModelPart, string> {
  return {
    err: errPart(input),
    strip: stripPart(input),
    head: headPart(input),
    rows: rowsPart(input),
    foot: footPart(input),
  };
}
