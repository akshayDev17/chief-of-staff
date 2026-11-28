// The model table on Models › Setup › Providers (the owner, 2026-11-28: "we
// can simply keep the first test a model table"), the section the page opens
// at once the provider has authorized the app.
//
//   modelParts(input) -> Record<ModelPart, string>   the parts a request swaps in place
//   nextStep(state) -> Step | undefined              the one solid blue button
//   parseView(params) / viewQuery(provider, view)    what a request shows, as an address
//
// One table lists every model the provider lists (models/test-model.ts
// listOffer), each row with Test: it runs the model's test call once, and the
// result opens under the row. A model whose latest test passed is one the
// user's tasks can use (models/usable.ts); there is no Add (the owner,
// 2026-11-27: "quite franky remove the add feature altogether"). Search
// matches any part of a model's name, maker or ID; the Maker filter, its own
// find box and its chips narrow the table; the Works / Doesn't work / Not
// tested yet strip filters it too, over a bar of the true ratios, and counts
// only the rows search and the Maker filter show. None of these sends a
// request: the page's script shows and hides rows, and recounts the strip.
//
// A row that cannot be tested has one action of its own: a model the
// account's settings leave out links those settings, then Check again reads
// the account's list; a router (priced per call by the model it picks) gets
// "Set price cap" (models/price-caps.ts). The side pane runs Test all models,
// with its estimate confirmed first, and Retest failed (N), whose results
// stay in the same run.
//
// Exactly one button is solid app blue in any state, and it is the next step
// (the owner, 2026-11-28): Refresh model list while the list is stale, then
// Test all N models, then Next: budgets; Run the test or Use this cap while
// their confirm is open; Connect when disconnected (page.ts). Everything else
// is outlined.
//
// Visible copy is the action lines; explanations sit in collapsed details.

import { BUDGETS_PATH, PROVIDERS_PATH } from "../paths";
import { esc } from "../prices/page";
import type { Dropped } from "../prices/openrouter";
import { makerKey, makerRowAttrs, nameMakers } from "../models/maker-filter";
import { strengthChip } from "../prices/tiers";
import { DEFAULT_CAP } from "../models/price-caps";
import { blockedReason, blockKind, MODEL_HELP_REASONS, refusalFix, refusalText, type OfferRow, type Refused, type TestRefusal } from "../models/test-model";
import { failedModels, isCurrentRun, rowState, type RetestPlan, type RowState, type ShownTest, type TestAllPlan, type TestAllRun } from "../models/test-all";
import type { TestRecord } from "../models/usable";
import type { Link, ProviderPlugin } from "../proxy/plugin";

export type Viewer = "owner" | "friend";

// What a request shows beyond the stored state: a result under a row, a
// notice, an open confirm or cap editor. Every one is an address
// (`viewQuery`), so a page without scripts reaches it by a link or a
// redirect, and the page's script fetches the same address in place.
export interface View {
  // The results under their rows, newest first: each test adds its own and
  // keeps the ones shown already, up to MAX_RESULTS. `reason`: a refusal that
  // records no test, made before any call or saying nothing about the model
  // (models/test-model.ts isVerdict), with the provider's `reply` where it gave one.
  results?: Array<{ model: string; reason?: TestRefusal; reply?: TestRecord["reply"] }>;
  notice?: { model: string; kind: "capped" | "allowed" | "left-out" };
  confirm?: "test-all" | "retest" | "disconnect";
  cap?: string;
  capProblem?: boolean;
  disconnected?: boolean;
}

const NOTICE_KINDS = new Set(["capped", "allowed", "left-out"]);
export const MAX_RESULTS = 8;
const CONFIRMS = new Set(["test-all", "retest", "disconnect"]);

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
  const confirm = params.get("confirm") ?? "";
  if (CONFIRMS.has(confirm)) view.confirm = confirm as View["confirm"];
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

export type Step = "connect" | "cap" | "confirm" | "refresh" | "test-all" | "next";

// The one solid blue button: the next step. None while a run goes on, unless
// it waits for a fresh model list.
export function nextStep(state: { connected: boolean; view: View; run?: TestAllRun; catalogCurrent: boolean; plan: TestAllPlan }): Step | undefined {
  if (!state.connected) return "connect";
  if (state.view.cap) return "cap";
  if (state.view.confirm === "test-all" || state.view.confirm === "retest") return "confirm";
  if (!state.catalogCurrent) return "refresh";
  if (state.run && !state.run.finishedAt) return undefined;
  if (state.run && isCurrentRun(state.run) && !state.run.earlierKey) return "next";
  return state.plan.wait ? "next" : "test-all";
}

export interface ModelsTableInput {
  plugin: ProviderPlugin;
  viewer: Viewer;
  rows: OfferRow[];
  // The provider's list as read, whether it follows the current rules, and
  // the entries dropped from it before anything reads it.
  catalog?: { readAt: string; current: boolean; dropped?: Dropped };
  plan: TestAllPlan;
  retest: RetestPlan;
  run?: TestAllRun;
  shown: Map<string, ShownTest>;
  // For a failed result under a row: the tasks whose saved main model it is,
  // each with the fallback it runs on now, where it has a usable one
  // (models/tasks.ts readTaskRoutes `stopped`).
  usedBy: Map<string, Array<{ task: string; fallback?: string }>>;
  view: View;
  step?: Step;
  // A problem from the last request, shown above the table.
  problem?: { text: string; details?: string };
  now: Date;
}

export type ModelPart = "err" | "strip" | "head" | "rows" | "foot" | "rail";

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
  ext: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13h-8.5V4.5H6.5"/></svg>',
  redo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3"/></svg>',
  cap: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 2.5h10M8 5v9.5M10.4 7.3c-.4-.8-1.2-1.2-2.4-1.2-1.3 0-2.2.7-2.2 1.6 0 2.3 4.8 1.2 4.8 3.6 0 1-1 1.7-2.5 1.7-1.2 0-2.2-.5-2.6-1.3"/></svg>',
  search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="5"/><path d="m11 11 3.5 3.5"/></svg>',
};

const newTab = (l: Link, cls: string): string => `<a class="${cls}" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`;

const shortName = (r: OfferRow): string => {
  const n = r.name ?? r.model;
  return n.includes(": ") ? n.slice(n.indexOf(": ") + 2) : n;
};

// ---------- the one rule for what a row shows ----------

// What a row's test state is made of: its place in the strip (rowState, the
// one rule the strip, its filters and Retest failed share); whether it is
// blocked (its account leaves it out, a router has no cap, the app can't
// call it, it has no price) or being tested in a run; the model's latest
// verdict; how its latest test went on an earlier key, which is no verdict;
// and the newest refusal that says nothing about the model
// (models/test-model.ts isVerdict), newer than that verdict, from the user's
// own Test (carried in the view) or from a run.
export interface RowFacts {
  state: RowState;
  blocked: boolean;
  testing: boolean;
  verdict?: { state: "passed" } | { state: "failed"; result: TestRecord };
  earlier?: "passed" | "failed";
  refusal?: { result: TestRecord; from: "test" | "run" };
}
export type RowAction = "credits" | "test-again" | "budgets";
export type RowTag = "doesnt-work" | "needs-credit" | "busy" | "couldnt-test";

// One test record as the row shows it, with the actions that answer it.
export interface Shown {
  result: TestRecord;
  actions: RowAction[];
}

// What the row shows: `state` for the strip and the filters (the verdict);
// its tag; `lead`, the failure its reason line and its result lead with;
// `note`, a newer refusal under a failed verdict, after it; `passed`, a
// result that says it passed; `ask`, the reason a friend's Ask Admin sends
// and the block it sits in, the one whose reason it is: the refusal just
// hit, else the lead's, and only a reason the model-help form takes
// (MODEL_HELP_REASONS); `earlier`, how its latest test went on an earlier
// key, the grey note on a row that reads Not tested yet.
export interface RowView {
  state: RowState;
  earlier?: "passed" | "failed";
  tag?: RowTag;
  lead?: Shown;
  note?: Shown & { from: "test" | "run" };
  passed: boolean;
  ask?: { reason: TestRefusal; on: "lead" | "note" };
}

const actionsFor = (r: TestRecord): RowAction[] =>
  r.reason === "no_credits" ? ["credits"] : r.reason === "busy" ? ["test-again"] : r.reason === "budget_spent" ? ["budgets"] : [];
const shownOf = (result: TestRecord): Shown => ({ result, actions: actionsFor(result) });
const askable = (reason: TestRefusal | undefined): TestRefusal | undefined => (reason && MODEL_HELP_REASONS.has(reason) ? reason : undefined);
// Ask Admin on `first`'s block when the form takes its reason, else on the
// lead with `lead`'s reason.
function askOn(first: TestRefusal | undefined, on: "lead" | "note", lead?: TestRefusal): Pick<RowView, "ask"> {
  const reason = askable(first);
  if (reason) return { ask: { reason, on } };
  const fallback = askable(lead);
  return fallback ? { ask: { reason: fallback, on: "lead" } } : {};
}

// A failed verdict leads, as "Doesn't work", with a newer refusal as its
// note; otherwise the refusal leads. An outcome tag (Needs credit, Busy,
// Couldn't test) shows only on a model still usable: passed and not blocked.
// While a run tests the row, only the user's own Test shows.
export function describeRow(f: RowFacts): RowView {
  const state = f.state;
  const earlier = f.earlier && !f.testing && !f.blocked ? { earlier: f.earlier } : {};
  const failed = !f.testing && f.verdict?.state === "failed" ? f.verdict.result : undefined;
  const refusal = f.testing && f.refusal?.from === "run" ? undefined : f.refusal;
  if (failed) {
    const note = refusal ? { ...shownOf(refusal.result), from: refusal.from } : undefined;
    return { state, tag: "doesnt-work", lead: shownOf(failed), ...(note ? { note } : {}), passed: false, ...askOn(note?.result.reason, "note", failed.reason) };
  }
  if (refusal) {
    const usable = !f.blocked && !f.testing && f.verdict?.state === "passed";
    const reason = refusal.result.reason;
    const tag: RowTag | undefined = usable ? (reason === "no_credits" ? "needs-credit" : reason === "busy" ? "busy" : "couldnt-test") : undefined;
    return { state, ...earlier, ...(tag ? { tag } : {}), lead: shownOf(refusal.result), passed: false, ...askOn(reason, "lead") };
  }
  return { state, ...earlier, passed: !f.testing && f.verdict?.state === "passed" };
}

// The facts of `r`'s row, from its shown test and the view.
function rowFacts(r: OfferRow, input: ModelsTableInput): RowFacts {
  const s = input.shown.get(r.model);
  const res = input.view.results?.find((x) => x.model === r.model);
  let refusal: RowFacts["refusal"];
  if (res?.reason) {
    const refused: Refused = { kind: "refused", model: r.model, reason: res.reason, ...(r.free ? { free: true } : {}) };
    const fix = refusalFix(refused, input.plugin);
    refusal = { result: { reason: res.reason, text: refusalText(refused, input.plugin), ...(fix ? { fix } : {}), ...(res.reply ? { reply: res.reply } : {}) }, from: "test" };
  }
  const blocked = Boolean(blockKind(r));
  const state = rowState(blocked, s);
  if (!s || s.state === "testing") return { state, blocked, testing: s?.state === "testing", ...(refusal ? { refusal } : {}) };
  if (s.state === "earlier") return { state, blocked, testing: false, earlier: s.earlier, ...(refusal ? { refusal } : {}) };
  const run = s.notVerdict ? s.result : s.later;
  refusal ??= run ? { result: run, from: "run" } : undefined;
  const verdict: RowFacts["verdict"] = s.notVerdict ? (s.verdict === "passed" ? { state: "passed" } : undefined) : s.state === "passed" ? { state: "passed" } : { state: "failed", result: s.result };
  return { state, blocked, testing: false, ...(verdict ? { verdict } : {}), ...(s.earlier ? { earlier: s.earlier } : {}), ...(refusal ? { refusal } : {}) };
}

const running = (input: ModelsTableInput): boolean => Boolean(input.run && !input.run.finishedAt);
const primaryIf = (input: ModelsTableInput, step: Step): string => (input.step === step ? "primary" : "outline");

// The strip's counts, by rowState; Doesn't work is failedModels, the same
// models Retest failed tests again. Each row carries its rowState as
// data-state, and the page's script sums those over the rows the search, the
// Maker filter and a strength show (page-script.ts), so the strip counts the
// view; these whole-list counts are what it shows unfiltered, and without
// the script.
function counts(input: ModelsTableInput): { w: number; f: number; p: number; t: number } {
  let w = 0;
  let p = 0;
  for (const r of input.rows) {
    const s = rowState(Boolean(blockKind(r)), input.shown.get(r.model));
    if (s === "works") w++;
    else if (s === "pending") p++;
  }
  const f = failedModels(input.rows, input.shown).length;
  return { w, f, p, t: w + f + p };
}

// ---------- the strip: run counts that filter the table ----------

function stripPart(input: ModelsTableInput): string {
  const c = counts(input);
  const cell = (key: RowState, label: string, v: number, cls: string) =>
    `<button type="button" class="cell" data-filter="${key}" data-k="cell-${key}" aria-pressed="false"><span class="l">${label}</span><span class="v num ${cls}">${v}</span></button>`;
  const pct = (n: number) => (c.t ? (n / c.t) * 100 : 0).toFixed(3);
  return `<div class="strip" role="group" aria-label="Show models">${cell("works", "Works", c.w, c.w ? "good" : "")}${cell("fails", "Doesn't work", c.f, c.f ? "bad" : "")}${cell("pending", "Not tested yet", c.p, "")}</div>
<div class="bar" role="img" aria-label="${c.w + c.f} of ${c.t} tested: ${c.w} work, ${c.f} don't"><i class="w" style="width:${pct(c.w)}%"></i><i class="f" style="width:${pct(c.f)}%"></i></div>
<div class="ends num"><span>0</span><span data-ends>${c.t} models</span></div>`;
}

// ---------- the list head: where the list is from, and Refresh ----------

function headPart(input: ModelsTableInput): string {
  const { plugin } = input;
  const short = esc(plugin.connect.guide.short);
  const read = input.catalog ? esc(stamp(input.catalog.readAt, input.now)) : "not yet";
  // A <div>, not a <p>: a form inside a <p> ends the paragraph.
  return `<div class="src"><span><span class="w">From ${short}, read</span><span class="n">Read</span> ${read}</span> · <form method="post" action="${action(plugin.provider, "refresh")}" data-fetch class="inline"><button type="submit" class="link" data-k="refresh" data-busy="Reading ${short}'s list…">Refresh</button></form></div><p class="unit">In / out per M tokens</p>`;
}

function errPart(input: ModelsTableInput): string {
  const p = input.problem;
  if (!p) return "";
  const details = p.details ? `<details><summary>Details</summary><p class="small">${esc(p.details)}</p></details>` : "";
  return `<div class="err" role="alert">${ICON.bad}<div><p>${esc(p.text)}</p>${details}</div></div>`;
}

// ---------- the rows ----------

const TAGS: Record<RowTag, string> = {
  "doesnt-work": `<span class="pill bad">Doesn't work</span>`,
  "needs-credit": '<span class="pill warn">Needs credit</span>',
  busy: '<span class="pill">Busy</span>',
  "couldnt-test": `<span class="pill">Couldn't test</span>`,
};

// The grey note on a row whose latest test ran on an earlier key.
const earlierNote = (v: RowView): string => (v.earlier ? `<span class="ek">${v.earlier === "passed" ? "Passed" : "Failed"} on an earlier key</span>` : "");

// "Latest test couldn't run. <its plain line, as written>".
const noteLine = (note: NonNullable<RowView["note"]>): string => `${note.from === "test" ? "This test" : "Latest test"} couldn't run. ${note.result.text}`;

function priceHtml(r: OfferRow, input: ModelsTableInput): string {
  const p = input.plugin.provider;
  if (blockKind(r) === "router") {
    return `<span class="price capcell"><a class="btn small outline capbtn" href="${esc(viewHref(p, { cap: r.model }, `#${rowAnchor(r.model)}`))}" data-view data-k="co-${esc(r.model)}" aria-label="Set price cap for ${esc(shortName(r))}" title="Set a price cap so it can be tested">${ICON.cap}<span>Set price cap</span></a></span>`;
  }
  if (r.cap) return `<span class="price num" title="Price cap">≤ ${usd(r.cap.input)} / ${usd(r.cap.output)}</span>`;
  if (!r.price) return '<span class="price dash" aria-label="no price">–</span>';
  return `<span class="price num">${usd(r.price.input)} / ${usd(r.price.output)}</span>`;
}

// The row's strength chip (prices/tiers.ts strengthChip), none for a router
// with no cap yet.
function chipOf(r: OfferRow): string {
  if (blockKind(r) === "router") return "";
  return strengthChip({ tier: r.tier, input: r.price?.input, output: r.price?.output, free: r.free }) ?? "";
}

const BLOCK_TITLE: Record<string, string> = {
  router: "Set a price cap first",
  account: "Allow it in your account settings first",
  not_callable: "The app can't call it",
  no_price: "No price yet",
};

function rowActions(r: OfferRow, input: ModelsTableInput): string {
  const { plugin } = input;
  const p = plugin.provider;
  const id = esc(r.model);
  const name = esc(shortName(r));
  const kind = blockKind(r);
  const off = Boolean(kind) || running(input);
  const title = kind ? BLOCK_TITLE[kind]! : running(input) ? "Test all is running" : "Test it now";
  const test = `<form method="post" action="${action(p, "test")}" data-fetch class="inline"><input type="hidden" name="model" value="${id}"><button type="submit" class="btn tbtn" data-k="t-${id}" data-busy="Testing…" title="${esc(title)}" aria-label="Test ${name}"${off ? " disabled" : ""}><span class="ico">${ICON.play}</span><span class="lbl">Test</span></button></form>`;
  if (kind !== "account") return `<span class="acts-row">${test}</span>`;
  const settings = plugin.connect.guide.accountSettings;
  const checked = input.view.notice?.model === r.model && input.view.notice.kind === "left-out";
  const allow = settings
    ? `<a class="ib act" href="${esc(settings.href)}" target="_blank" rel="noopener noreferrer" data-allow="${id}" data-k="al-${id}" title="Allow it in ${esc(settings.label)} (opens ${esc(new URL(settings.href).hostname)})" aria-label="Allow ${name} in ${esc(settings.label)}"${checked ? " hidden" : ""}>${ICON.ext}</a>`
    : "";
  const check = `<form method="post" action="${action(p, "check-account")}" data-fetch class="inline" data-check-for="${id}"${checked || !settings ? "" : " hidden"}><input type="hidden" name="model" value="${id}"><button type="submit" class="ib act" data-k="ac-${id}" data-busy="" title="Check again: reads your account's model list" aria-label="Check again whether ${name} is allowed">${ICON.redo}</button></form>`;
  return `<span class="acts-row">${test}${allow}${check}</span>`;
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

// The result under a row: the lead's plain line and its actions, the note
// with its own, the provider's own words collapsed.
function resultHtml(r: OfferRow, input: ModelsTableInput, v: RowView): string {
  const { plugin } = input;
  const p = plugin.provider;
  const hide = `<button type="button" class="link hide" data-hide="${esc(r.model)}">Hide</button>`;
  if (v.passed) return `<div class="result ok" role="status"><p class="v">${ICON.ok}<span><strong>${esc(shortName(r))} passed.</strong> Tasks can use it.</span>${hide}</p></div>`;
  if (!v.lead) return "";
  const credits = plugin.connect.guide.credits;
  const ACTION: Record<RowAction, string> = {
    credits: credits ? newTab(credits, "btn small outline ext") : "",
    "test-again": `<form method="post" action="${action(p, "test")}" data-fetch class="inline"><input type="hidden" name="model" value="${esc(r.model)}"><button type="submit" class="btn small outline" data-k="again-${esc(r.model)}" data-busy="Testing…">Test again</button></form>`,
    budgets: `<a class="btn small outline" href="${BUDGETS_PATH}">Budgets</a>`,
  };
  const ask =
    input.viewer === "friend" && v.ask
      ? `<form method="post" action="${action(p, "model-help")}" data-fetch class="inline"><input type="hidden" name="model" value="${esc(r.model)}"><input type="hidden" name="reason" value="${esc(v.ask.reason)}"><button type="submit" class="btn small outline" data-k="help-${esc(r.model)}">Ask Admin for help</button></form>`
      : "";
  const acts = (s: Shown, block: "lead" | "note"): string => {
    const html = s.actions.map((a) => ACTION[a]).join("") + (v.ask?.on === block ? ask : "");
    return html ? `<div class="acts">${html}</div>` : "";
  };
  const usedBy = v.tag === "doesnt-work" ? (input.usedBy.get(r.model) ?? []) : [];
  const none = usedBy.filter((u) => !u.fallback).map((u) => u.task);
  const used = [
    ...usedBy.flatMap((u) => (u.fallback ? [`<p>${esc(u.task)} runs on its fallback ${esc(u.fallback)} now.</p>`] : [])),
    none.length ? `<p>${esc(joinAnd(none))} ${none.length === 1 ? "reads" : "read"} “Choose a model” now.</p>` : "",
  ].join("");
  const note = v.note ? `<div class="later"><p>${esc(noteLine(v.note))}</p>${acts(v.note, "note")}</div>` : v.earlier ? `<div class="later"><p>${earlierNote(v)}. Tasks can use it once it passes on this key.</p></div>` : "";
  const det = [...detailParts(plugin, v.lead.result, credits?.href), ...(v.note ? detailParts(plugin, v.note.result, credits?.href) : [])].map((d) => `<p>${d}</p>`).join("");
  const cls = v.lead.result.reason === "no_credits" ? "warn" : "bad";
  return `<div class="result ${cls}" role="alert"><p class="v">${ICON.bad}<span><strong>${esc(v.lead.result.text)}</strong></span>${hide}</p>${used}${acts(v.lead, "lead")}${note}${det ? `<details><summary>Details</summary>${det}</details>` : ""}</div>`;
}

function capEditor(r: OfferRow, input: ModelsTableInput): string {
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

function noticeHtml(r: OfferRow, input: ModelsTableInput): string {
  const n = input.view.notice!;
  const hide = `<button type="button" class="link hide" data-hide="">Hide</button>`;
  if (n.kind === "left-out") {
    return `<div class="result warn" role="status"><p class="v">${ICON.bad}<span>Your ${esc(input.plugin.connect.guide.short)} settings still leave it out.</span>${hide}</p></div>`;
  }
  const text = n.kind === "capped" && r.cap ? `Capped at ${usd(r.cap.input)} / ${usd(r.cap.output)} per M tokens. Test it now.` : "Now allowed for your account. Test it now.";
  return `<div class="result ok" role="status"><p class="v">${ICON.ok}<span>${esc(text)}</span>${hide}</p></div>`;
}

function rowHtml(r: OfferRow, input: ModelsTableInput, makerNames: Map<string, string>): string {
  const { plugin, view } = input;
  const p = plugin.provider;
  const v = describeRow(rowFacts(r, input));
  const kind = blockKind(r);
  const makerId = makerKey(r.model);
  const maker = makerNames.get(makerId) ?? makerId;
  const name = shortName(r);
  const id = esc(r.model);
  const anchor = rowAnchor(r.model);
  // A tag only where it says something: a passing row carries none (a status
  // on hundreds of rows says nothing); the strip's Works cell finds them.
  let tags = "";
  if (r.free) tags += '<span class="pill free">Free</span>';
  if (v.tag) tags += TAGS[v.tag];
  const resultHere = view.results?.some((x) => x.model === r.model) ?? false;
  const plainMeta = `<span class="meta">${v.earlier ? `${earlierNote(v)} · ` : ""}<span data-hl>${esc(maker)}</span> · <span data-hl>${id}</span></span>`;
  let meta: string;
  if (kind === "account") meta = `<span class="meta" title="${esc(blockedReason(r, plugin) ?? "")}">Your ${esc(plugin.connect.guide.short)} settings leave it out</span>`;
  else if (kind === "router") meta = `<span class="meta">Priced per call by the model it picks</span>`;
  else if (kind === "not_callable") meta = `<span class="meta" title="${esc(plugin.connect.notCallableReason(r.model))}">Can't be tested · ${esc(plugin.connect.notCallableReason(r.model))}</span>`;
  else if (kind === "no_price") meta = `<span class="meta">No price yet · <span data-hl>${id}</span></span>`;
  else if (r.cap && !v.lead) {
    // Only the maker and ID clip; Change cap always shows whole, even on a phone.
    meta = `<span class="meta capped"><span class="clip"><span data-hl>${esc(maker)}</span> · <span data-hl>${id}</span> · capped</span><span class="cg">&nbsp;· <a class="link" href="${esc(viewHref(p, { cap: r.model }, `#${anchor}`))}" data-view data-k="cg-${id}">Change cap</a></span></span>`;
  } else if (v.lead && !resultHere) {
    const note = v.note ? ` · <span class="later">${esc(noteLine(v.note))}</span>` : v.earlier ? ` · ${earlierNote(v)}` : "";
    meta = `<span class="meta why">${esc(v.lead.result.text)} · <button type="button" class="link" data-det="${esc(anchor)}" aria-expanded="false" aria-controls="det-${esc(anchor)}">Details</button>${note}</span>`;
  } else meta = plainMeta;
  let extra = "";
  if (view.cap === r.model && r.router) extra = capEditor(r, input);
  else if (view.notice?.model === r.model) extra = noticeHtml(r, input);
  else if (resultHere) extra = resultHtml(r, input, v);
  else if (v.lead) {
    const omit = plugin.connect.guide.credits?.href;
    const parts = [`${esc(maker)} · ${id}`, ...detailParts(plugin, v.lead.result, omit), ...(v.note ? detailParts(plugin, v.note.result, omit) : [])];
    const det = parts.map((d) => `<span>${d}</span>`).join("");
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
  const dropped = d
    ? `<li>Every model ${short} lists is here but the ones no test can pass: ${counted(d.batch, "“:batch” variant", "“:batch” variants")} (they answer no chat call), ${counted(d.alias, "“~” alias", "“~” aliases")} (each points to a model listed under its own ID), ${counted(d.router, "router no price cap can bound", "routers no price cap can bound")} (a panel of models, or another maker's router) and ${counted(d.unusable ?? 0, "model that gives audio, images or video, gives no text, or lists no price", "models that give audio, images or video, give no text, or list no price")}.</li>`
    : `<li>Every model ${short} lists is here.</li>`;
  const terms = input.plugin.connect.freeModelTerms;
  const free = terms && input.rows.some((r) => r.free)
    ? `<li>Free models work without credit. ${esc(terms.text)} ${terms.links.map((l) => newTab(l, "ext")).join(" · ")}</li>`
    : "";
  return `<details><summary>About this list</summary><ul>
${dropped}
<li>Test checks a model now. Tasks can use a model whose latest test passed; a later failed test takes it out.</li>
<li>A model your ${short} settings leave out links those settings; Check again reads your account's list.</li>
<li>A router priced per call by the model it picks takes a price cap, which gives it a price the budget stop can use: ${short} then picks only models at or under the cap, and none with a fee per search or per request.</li>
<li>Test all's estimate is each model's last measured test cost, else its list price for the test's tokens, plus one search for a model that searches the web on its own.</li>
<li>Strength comes from the input price per million tokens: Smallest under $0.50, Middle to $2.50, Strongest above.</li>
<li>Free: gives only text and costs $0 on every price ${short} lists.</li>
${free}
</ul></details>`;
}

// ---------- the side pane: Test all and Retest failed ----------

function refreshButton(input: ModelsTableInput, cls: string): string {
  const short = esc(input.plugin.connect.guide.short);
  return `<form method="post" action="${action(input.plugin.provider, "refresh")}" data-fetch><button type="submit" class="btn wide ${cls}" data-k="refresh-ta" data-busy="Reading ${short}'s list…">Refresh model list</button></form>`;
}

function confirmBox(input: ModelsTableInput, question: string, extra: string, verb: string, label: string, k: string): string {
  const p = input.plugin.provider;
  return `<div class="confirm" role="alertdialog" aria-labelledby="ta-q"><p id="ta-q"><strong>${esc(question)}</strong></p>
<p class="why">Billed to your ${esc(input.plugin.connect.guide.name)} account.${extra ? ` ${esc(extra)}` : ""}</p>
<div class="acts"><form method="post" action="${action(p, verb)}" data-fetch class="inline"><button type="submit" class="btn ${primaryIf(input, "confirm")} small" data-k="${k}" data-autofocus>${esc(label)}</button></form><a class="link" href="${esc(viewHref(p, {}, "#ta"))}" data-view data-k="${k}-cancel">Cancel</a></div></div>`;
}

function railPart(input: ModelsTableInput): string {
  const { plan, retest, run, view, plugin } = input;
  const p = plugin.provider;
  const isRunning = running(input);
  const retesting = isRunning && Boolean(run?.retestedAt);
  const current = input.catalog?.current ?? false;
  const stale = Boolean(run?.finishedAt && !isCurrentRun(run));
  let line: string;
  if (run && isRunning && !retesting) {
    line = `Testing… <span class="num">${run.done}</span> of <span class="num">${run.modelCount}</span> · spent <span class="num">${formatCost(run.realCostUsd)}</span> · estimate <span class="num">${formatCost(run.estimateUsd)}</span>`;
  } else if (run && retesting) {
    const left = run.tests.filter((t) => t.state === "queued" || t.state === "running").length;
    const n = run.retestCount ?? left;
    line = `Retesting… <span class="num">${n - left}</span> of <span class="num">${n}</span> that failed · spent <span class="num">${formatCost(run.realCostUsd)}</span>`;
  } else if (run) {
    const again = run.retestedAt ? ` · retested ${run.retestCount ?? 0} at ${esc(stamp(run.retestedAt, input.now))}` : "";
    const key = run.earlierKey ? " on an earlier key" : "";
    line = `Tested ${esc(stamp(run.startedAt, input.now))}${key}${again} · spent <span class="num">${formatCost(run.realCostUsd)}</span> · estimate <span class="num">${formatCost(run.estimateUsd)}</span>`;
  } else line = "Not run yet for this account.";
  const staleBox = stale
    ? `<div class="stale"><p>The ${esc(stamp(run!.startedAt, input.now))} run used the old model list, so Retest failed waits for a new run. ${current ? "Test all again first." : "Refresh, then test all again."}</p>${current ? "" : refreshButton(input, primaryIf(input, "refresh"))}</div>`
    : "";
  let act: string;
  if (view.confirm === "test-all" && !plan.wait) {
    act = confirmBox(input, `Test all ${plan.models.length} models for about ${formatCost(plan.estimateUsd)}?`, "", "test-all", "Run the test", "ta-run");
  } else if (view.confirm === "retest" && !retest.wait) {
    act = confirmBox(
      input,
      `Retest the ${retest.models.length} that failed for about ${formatCost(retest.estimateUsd)}?`,
      retest.skipped ? `Skips ${retest.skipped} no longer on the model list.` : "",
      "retest",
      "Run the retest",
      "rt-run",
    );
  } else {
    let why = "";
    const taOn = !plan.wait && !isRunning;
    let taLabel = `Test all ${plan.models.length} models`;
    if (isRunning && !retesting && run) taLabel = `Testing… ${run.done} of ${run.modelCount}`;
    if (!current) why = stale ? "" : `Waiting for a fresh model list.${refreshButton(input, primaryIf(input, "refresh"))}`;
    else if (isRunning && !retesting) why = "You can leave and come back. This page updates by itself.";
    else if (retesting) why = "Retesting the ones that failed.";
    else if (plan.wait) why = esc(plan.wait);
    else why = `About ${formatCost(plan.estimateUsd)}, billed to your ${esc(plugin.connect.guide.name)} account.`;
    const ta = taOn
      ? `<a class="btn ${primaryIf(input, "test-all")}" href="${esc(viewHref(p, { confirm: "test-all" }, "#ta"))}" data-view data-k="ta">${esc(taLabel)}</a>`
      : `<button type="button" class="btn outline" disabled data-k="ta">${esc(taLabel)}</button>`;
    const rtN = retest.models.length && !retesting ? ` <span class="num">(${retest.models.length})</span>` : "";
    const rt = retest.wait
      ? `<button type="button" class="btn outline" disabled data-k="rt"><span>Retest failed${rtN}</span></button>`
      : `<a class="btn outline" href="${esc(viewHref(p, { confirm: "retest" }, "#ta"))}" data-view data-k="rt"><span>Retest failed${rtN}</span></a>`;
    const rtWhy = retest.wait && !stale && !isRunning ? `<p class="why">Retest failed · ${esc(retest.wait)}</p>` : !retest.wait && retest.skipped ? `<p class="why">Retest failed skips ${retest.skipped} no longer on the model list.</p>` : "";
    // Shown by the page's script while search, the Maker filter or a
    // strength narrows the table, whose strip then counts only those rows.
    const whole = '<p class="why" data-whole-list hidden>Test all and Retest failed cover the whole list, not only the matching models.</p>';
    act = `<div class="two">${ta}${rt}</div>${why ? `<div class="why">${why}</div>` : ""}${rtWhy}${whole}`;
  }
  return `<h3 id="ta">Test all</h3><p class="runline">${line}</p>${staleBox}<div class="ta-act">${act}</div>`;
}

export function modelParts(input: ModelsTableInput): Record<ModelPart, string> {
  return {
    err: errPart(input),
    strip: stripPart(input),
    head: headPart(input),
    rows: rowsPart(input),
    foot: footPart(input),
    rail: railPart(input),
  };
}

// Whether the page should keep asking for the run's progress.
export const isRunning = (run: TestAllRun | undefined): boolean => Boolean(run && !run.finishedAt);
