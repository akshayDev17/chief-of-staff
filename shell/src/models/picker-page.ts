// Models › Setup › Model for each task, rendered on the server (design-v3 1.5
// and 10.1, T18).
//
//   GET  /chief-of-staff/models/setup/tasks
//   POST /chief-of-staff/models/setup/tasks/change    task (one or more), main.<task>, fallback.<task>
//   POST /chief-of-staff/models/setup/tasks/accept    the one tap: every proposal is taken
//   POST /chief-of-staff/models/setup/tasks/use-free  the one tap for free models, where nothing is proposed
//   POST /chief-of-staff/models/setup/tasks/help      friends only: "Ask Admin for help"
//   POST /chief-of-staff/models/setup/tasks/try       task: Try it, one real call on its saved models
//
// Each tap also takes the fields of /change for the rows the user changed
// and has not saved, saved as chosen (all or none) with it in one request,
// the tap leaving those rows as the user chose them. Help saves nothing: in
// place, its answer is only what it says, and the page keeps its rows.
//
// One row per task: its suggested strength, and a dropdown for its main model
// and one for its fallback. Each dropdown lists every one of the user's Ready
// models (models/ready.ts: on the account's own list, with tool use, nothing
// blocking it, and free or the account has credit left; no
// test needed, the owner, 2026-11-28) whose strength chip is the task's (the
// owner, 2026-11-27: "when suggested strenght == Smallest --> the dropdown
// next to it should only contain all passing run models tagged with the
// smallest chip"), the cheapest first, grouped under their provider, so choosing one
// chooses the provider and the model (OpenRouter is the one provider today).
// A long list has a search box at its top. Each model shows its name, its ID
// and its list price per million input and output tokens, or Free.
//
// A task's saved choice is always shown, even where its model is no longer in
// the list: one of another strength saved before the rule says so and keeps
// running; one that needs credit says so and keeps its
// place, its calls falling to the fallback when it fails; one the provider no
// longer offers says why (it is no longer on the provider's list, the
// account's settings leave it out, it needs a price cap, it lists no tool
// use), with the action that fixes it, and the row says whether the task runs
// on its fallback or has no model. A task whose strength has no Ready model
// says so in its row, with Add credits where that strength's paid models need
// credit, else a link to Providers and models showing that strength's models.
// The account line's credit figure is read live on every visit
// (models/ready.ts readAccountLive), so credit added on the provider fills
// the lists on the next visit, with no click.
//
// Choosing a model sends nothing (the owner, 2026-11-27: "upon changing a
// model in the dropdwon, i believe some request is sent"): the changed rows
// are counted in a bar with Save and Undo, and Save sends them all at once in
// place, with no reload and the address unchanged. Without scripts the
// dropdowns are plain selects, each row has its own Save, and every form
// posts and redirects back (post-redirect-get). One solid blue button at a
// time: Save while a row is changed, else the first of Accept all with one
// tap, Use my free models, the first row's fix, and Next (none after this
// last screen while the checklist's next item is not built).
//
// A free model is never proposed, only chosen: in its dropdown, or with one tap
// for the tasks of its strength (Smallest) that have no model and no proposal
// (a $0 account's Ready models are all free), which the page offers and explains, with the
// provider's own terms for free models. A model with no tool use is never
// listed (models/test-model.ts listOffer); one saved before that rule says so.
// Friend screens say "Admin" for the owner.
//
// Try it, on each row with a saved model, sends the task's one short sample
// prompt through the pipeline its own calls use (models/try-task.ts) and
// shows, under the row and in place, the reply, the model that answered
// (main or fallback), its tokens, cost and time, and the month's spend
// after it. It reads the saved models only, never writes them, and waits
// while the row has changes not saved. Without scripts it posts, and the
// page comes back with the result under the row.

import { esc } from "../prices/page";
import type { Tier } from "../prices/tiers";
import type { Provider } from "../prices/types";
import { PROVIDERS_PATH, TASK_MODELS_PATH, USAGE_PATH } from "../paths";
import { ICON, rowAnchor, usd, viewQuery } from "../providers/models-table";
import { PAGE_STYLE } from "../providers/page-style";
import type { Viewer } from "../providers/page";
import type { Link, PluginRegistry } from "../proxy/plugin";
import { PROVIDER_NAMES } from "../proxy/proxy";
import { budgetText, money } from "../proxy/budget-bar";
import { modelsSubtabs, nextAction, SETUP_TABS } from "./setup-tabs";
import { tryTask, type TryFailure, type TryOutcome } from "./try-task";
import { readModelNames, readToReady } from "./picker-data";
import { readAccountLive } from "./ready";
import { PROVIDERS } from "../prices/types";
import { PICKER_SCRIPT } from "./picker-script";
import { FREE_NOTE } from "./test-model";
import {
  acceptProposals,
  changeTasks,
  type ChangeRefusal,
  freeRoutes,
  modelKey,
  offeredFor,
  readTaskRoutes,
  taskById,
  TASKS,
  useFreeModels,
  type ChangeProblem,
  type Offered,
  type Task,
  type TaskChange,
  type TaskRoute,
  type NotUsable,
} from "./tasks";

// Where a strength with no Ready model can get one: Add credits where its
// paid models need credit (`needCredit`, per strength), else Providers and
// models showing that strength's models.
export interface ToReady {
  provider: Provider;
  connected: boolean;
  needCredit: Partial<Record<Tier, number>>;
  credits?: Link;
}

export interface PickerPageInput {
  viewer: Viewer;
  offered: Offered[];
  routes: TaskRoute[];
  // Each provider's short name on screen ("OpenRouter").
  providerName: (p: Provider) => string;
  // True for a model known to make no tool call.
  noToolUse: (m: { provider: Provider; model: string }) => boolean;
  // The provider's own conditions on free models, shown when one is offered.
  freeTerms?: { text: string; links: Link[] };
  // The page of the user's account settings at the provider, where it has one.
  accountSettings?: (p: Provider) => Link | undefined;
  // The provider's page to add credits, where it has one.
  credits?: (p: Provider) => Link | undefined;
  // The provider's name for a model no longer offered, where its list has one.
  nameOf?: (m: { provider: Provider; model: string }) => string | undefined;
  toReady?: ToReady;
  problem?: string;
  said?: string;
  // A Try it's result, shown under its task's row.
  tried?: TryOutcome;
}

type Ref = { provider: Provider; model: string };

// What a dropdown shows for one model: its name, ID and price, or Free.
function modelView(m: Offered | Ref, input: PickerPageInput, tag = ""): string {
  const o = "tier" in m || "inputUsd" in m || "free" in m ? (m as Offered) : undefined;
  const name = o?.name ?? input.nameOf?.(m) ?? m.model;
  const price = o?.free
    ? `<span class="pill free" title="${esc(FREE_NOTE)}">Free</span>`
    : o?.inputUsd !== undefined && o.outputUsd !== undefined
      ? `<span class="ov-pr num">${usd(o.inputUsd)} / ${usd(o.outputUsd)}</span>`
      : "";
  const tool = input.noToolUse(m) ? `<span class="ov-x">no tool use</span>` : "";
  return `<span class="ov"><span class="ov-l1"><span class="ov-nm">${esc(name)}</span>${price}</span><span class="ov-l2"><span class="ov-id">${esc(m.model)}</span>${tool}${tag}</span></span>`;
}

// A plain select's words for one model, for a page without scripts.
function optionText(m: Offered | Ref, input: PickerPageInput, note = ""): string {
  const o = "inputUsd" in m || "free" in m ? (m as Offered) : undefined;
  const name = o?.name ?? input.nameOf?.(m) ?? m.model;
  const price = o?.free ? FREE_NOTE : o?.inputUsd !== undefined && o.outputUsd !== undefined ? `${usd(o.inputUsd)} / ${usd(o.outputUsd)} per M tokens` : "";
  return [name, m.model, price, input.noToolUse(m) ? "no tool use" : "", note].filter(Boolean).join(" · ");
}

const WHY: Record<NotUsable, string> = {
  not_listed: "is no longer on the provider's list",
  left_out: "is left out by your account settings",
  no_cap: "needs a price cap",
  no_tools: "lists no tool use",
  unknown: "is no longer offered",
};

const whyText = (why: NotUsable, provider: Provider, input: PickerPageInput): string => {
  const name = input.providerName(provider);
  if (why === "not_listed") return `is no longer on ${name}'s list`;
  if (why === "left_out") return `is left out by your ${name} settings`;
  return WHY[why];
};

const newTab = (l: Link, cls: string): string => `<a class="${cls}" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`;

// The one action that fixes a saved model the provider no longer offers.
function fixFor(m: Ref, why: NotUsable, pickId: string, input: PickerPageInput, cls: string): string {
  switch (why) {
    case "left_out": {
      const settings = input.accountSettings?.(m.provider);
      return settings ? newTab(settings, `${cls} ext`) : "";
    }
    case "no_cap":
      return `<a class="${cls}" href="${esc(`${PROVIDERS_PATH}?${viewQuery(m.provider, { cap: m.model })}#${rowAnchor(m.model)}`)}">Set its price cap</a>`;
    default:
      return `<a class="${cls}" href="#${pickId}" data-open="${pickId}">Choose another</a>`;
  }
}

// What makes a strength's models Ready: Add credits where its paid models
// need credit, else its models on Providers and models.
function readyLink(tier: Tier, input: PickerPageInput, cls: string): string {
  const t = input.toReady;
  if (!t) return "";
  if (!t.connected) return `<a class="${cls}" href="${PROVIDERS_PATH}">Connect ${esc(input.providerName(t.provider))}</a>`;
  if ((t.needCredit[tier] ?? 0) > 0 && t.credits) return newTab(t.credits, `${cls} ext`);
  const q = new URLSearchParams({ provider: t.provider, strength: tier });
  return `<a class="${cls}" href="${esc(`${PROVIDERS_PATH}?${q}#test`)}">See ${tier} models</a>`;
}

// Why a saved model that is offered but not Ready keeps its place: it needs
// credit. Its calls still try it first.
function notReadyNote(m: Offered | undefined, role: "main model" | "fallback", hasFallback: boolean): string {
  if (m?.state !== "credit") return "";
  return role === "main model" ? `Its main model needs credit. ${hasFallback ? "Calls fall to its fallback meanwhile." : "Add a fallback."}` : `Its fallback needs credit.`;
}

// The action beside that note: Add credits, or the model's row on Providers
// and models.
function notReadyFix(m: Offered, input: PickerPageInput): (cls: string) => string {
  const credits = input.credits?.(m.provider);
  return (cls) => (credits ? newTab(credits, `${cls} ext`) : `<a class="${cls}" href="${esc(`${PROVIDERS_PATH}?${viewQuery(m.provider, {})}#${rowAnchor(m.model)}`)}">See why</a>`);
}

// What a task shows now in each role: its saved choice, offered or not, else
// its proposal while it waits for the tap.
interface Shown {
  main?: { ref: Ref; model?: Offered; why?: NotUsable };
  fallback?: { ref: Ref; model?: Offered; why?: NotUsable };
}

function shownFor(r: TaskRoute): Shown {
  if (r.pending && r.proposal && !r.current) return { main: { ref: r.proposal.main, model: r.proposal.main }, ...(r.proposal.fallback ? { fallback: { ref: r.proposal.fallback, model: r.proposal.fallback } } : {}) };
  const gone = r.fallbackGone ? { fallback: { ref: r.fallbackGone, why: r.fallbackGone.why } } : {};
  if (r.current) return { main: { ref: r.current.main, model: r.current.main }, ...(r.current.fallback ? { fallback: { ref: r.current.fallback, model: r.current.fallback } } : gone) };
  if (r.stopped) return { main: { ref: r.stopped.main, why: r.stopped.why }, ...(r.stopped.fallback ? { fallback: { ref: r.stopped.fallback, model: r.stopped.fallback } } : gone) };
  return {};
}

// What a row needs the user to do: nothing, or the one action its note offers.
interface RowNeed {
  // Each sentence, with the role it is about: hidden once that role is changed.
  note: Array<{ text: string; about?: "main" | "fallback" }>;
  // The action's HTML, given its button class.
  action?: (cls: string) => string;
  // The task has no model now.
  blocked: boolean;
}

function rowNeed(r: TaskRoute, list: Offered[], shown: Shown, input: PickerPageInput): RowNeed {
  const tier = r.task.tier;
  const id = r.task.id;
  if (r.stopped) {
    const m = r.stopped.main;
    const name = input.nameOf?.(m) ?? m.model;
    const runs = r.stopped.fallback ? `Runs on its fallback for now.` : `No model now: its calls are refused.`;
    return { note: [{ text: `${esc(name)} ${esc(whyText(r.stopped.why, m.provider, input))}. ${runs}`, about: "main" }], action: (cls) => fixFor(m, r.stopped!.why, `main-${id}`, input, cls), blocked: !r.stopped.fallback };
  }
  if (!shown.main && !list.length) {
    const credit = (input.toReady?.needCredit[tier] ?? 0) > 0;
    return { note: [{ text: `No ${tier} model is ready yet.${credit ? " Paid ones need credit." : ""}` }], action: (cls) => readyLink(tier, input, cls), blocked: true };
  }
  if (!shown.main) return { note: [], blocked: true };
  const notes: RowNeed["note"] = [];
  // An accepted task whose proposal has changed keeps its models until the tap.
  if (r.pending && r.current && r.proposal) {
    const p = r.proposal;
    notes.push({ text: `Proposed now: ${esc(p.main.name ?? p.main.model)}${p.fallback ? `, with ${esc(p.fallback.name ?? p.fallback.model)} as its fallback` : ""}.` });
  }
  let action: RowNeed["action"] | undefined;
  const off = (m: Offered | undefined, role: string) => (m?.tier && m.tier !== tier ? `Its ${role} is a ${m.tier} model, kept from before.` : m && !m.tier ? `Its ${role} has no ${tier} chip, kept from before.` : "");
  const offMain = off(shown.main.model, "main model");
  if (offMain) notes.push({ text: offMain, about: "main" });
  const mainNote = notReadyNote(shown.main.model, "main model", Boolean(shown.fallback?.model));
  if (mainNote) {
    notes.push({ text: mainNote, about: "main" });
    action = notReadyFix(shown.main.model!, input);
  }
  if (r.fallbackGone && !r.pending) {
    const f = r.fallbackGone;
    notes.push({ text: `Its fallback ${esc(input.nameOf?.(f) ?? f.model)} ${esc(whyText(f.why, f.provider, input))}.`, about: "fallback" });
    action = (cls) => fixFor(f, f.why, `fallback-${id}`, input, cls);
  } else {
    const offFallback = off(shown.fallback?.model, "fallback");
    if (offFallback) notes.push({ text: offFallback, about: "fallback" });
    const fallbackNote = notReadyNote(shown.fallback?.model, "fallback", false);
    if (fallbackNote) {
      notes.push({ text: fallbackNote, about: "fallback" });
      action ??= notReadyFix(shown.fallback!.model!, input);
    }
    if (!shown.fallback && list.filter((m) => !shown.main || modelKey(m) !== modelKey(shown.main.ref)).length === 0) {
      notes.push({ text: `No other ${tier} model is ready for a fallback yet.`, about: "fallback" });
      action ??= (cls) => readyLink(tier, input, cls);
    }
  }
  return { note: notes, action, blocked: false };
}

// One dropdown: a plain select (no script) and the picker the script shows.
function dropdown(r: TaskRoute, role: "main" | "fallback", list: Offered[], shown: Shown, input: PickerPageInput): string {
  const id = `${role}-${r.task.id}`;
  const tier = r.task.tier;
  const now = shown[role];
  const value = now ? modelKey(now.ref) : "";
  const inList = now ? list.some((m) => modelKey(m) === value) : false;
  // The saved model where the list no longer has it, kept as it is.
  const state = now?.model?.state;
  const keptTag = now && !inList
    ? now.why
      ? `<span class="pill bad">Not offered</span>`
      : state === "credit"
        ? `<span class="pill warn">Needs credit</span>`
        : now.model?.tier ? `<span class="pill">${now.model.tier}</span>` : `<span class="pill">Other fees</span>`
    : "";
  const keptNote = now && !inList ? (now.why ? `${WHY[now.why]}` : state === "credit" ? "needs credit" : "kept from before") : "";
  const label = role === "main" ? "Main model" : "Fallback";
  // Nothing to choose: the strength has no Ready model, and none is saved.
  const empty = !list.length && !now;
  // The plain select.
  const providers = [...new Set(list.map((m) => m.provider))];
  const groups = providers
    .map((p) => `<optgroup label="${esc(input.providerName(p))}">${list.filter((m) => m.provider === p).map((m) => `<option value="${esc(modelKey(m))}"${modelKey(m) === value ? " selected" : ""}>${esc(optionText(m, input))}</option>`).join("")}</optgroup>`)
    .join("");
  const first =
    (now && !inList ? `<option value="${esc(value)}" selected>${esc(optionText(now.model ?? now.ref, input, keptNote))}</option>` : "") +
    (role === "fallback" ? `<option value=""${value ? "" : " selected"}>None</option>` : !now ? `<option value="" selected>${empty ? `No ${tier} model yet` : `Choose a ${tier} model`}</option>` : "");
  const select = `<select class="nsel" id="${id}" name="${role}.${esc(r.task.id)}" data-orig="${esc(value)}" aria-labelledby="lbl-${id}"${empty ? " disabled" : ""}>${first}${groups}</select>`;
  // The picker.
  const opt = (m: Offered) => `<li role="option" id="o-${id}-${esc(rowAnchor(modelKey(m)))}" data-value="${esc(modelKey(m))}" data-hay="${esc(`${m.name ?? ""} ${m.model} ${input.providerName(m.provider)}`.toLowerCase())}" aria-selected="${modelKey(m) === value}">${modelView(m, input)}</li>`;
  const options =
    (role === "fallback" ? `<li role="option" id="o-${id}-none" data-value="" data-hay="none" aria-selected="${!value}"><span class="ov"><span class="ov-l1"><span class="ov-nm">None</span></span><span class="ov-l2"><span class="ov-id">No fallback</span></span></span></li>` : "") +
    providers.map((p) => `${providers.length > 1 || list.length ? `<li class="pick-group" role="presentation">${esc(input.providerName(p))}</li>` : ""}${list.filter((m) => m.provider === p).map(opt).join("")}`).join("");
  const placeholder = `<span class="ov"><span class="ov-l1"><span class="ov-nm ov-ph">${role === "fallback" ? "None" : empty ? `No ${tier} model yet` : `Choose a ${tier} model`}</span></span>${role === "fallback" && !value && !empty ? `<span class="ov-l2"><span class="ov-id">No fallback</span></span>` : ""}</span>`;
  const shownView = now ? modelView(now.model ?? now.ref, input, keptTag) : placeholder;
  const search = list.length > 6 ? `<input type="search" class="pick-q" placeholder="Search ${list.length} ${tier} models" aria-label="Search ${tier} models" aria-controls="pl-${id}" autocomplete="off" spellcheck="false">` : "";
  const picker = `<div class="pick" data-pick="${id}" data-role="${role}"><button type="button" class="pick-btn" id="pb-${id}" aria-haspopup="listbox" aria-expanded="false" aria-controls="pl-${id}" aria-labelledby="lbl-${id} pb-${id}"${empty ? " disabled" : ""}><span class="pv">${shownView}</span>${empty ? "" : `<span class="chev">${ICON.chev}</span>`}</button>${
    empty ? "" : `<div class="pick-pop" hidden>${search}<ul role="listbox" id="pl-${id}" aria-label="${tier} models" tabindex="-1">${options}</ul><p class="pick-none" hidden>No model matches.</p></div>`
  }</div>`;
  return `<div class="t-pick"><span class="pl" id="lbl-${id}">${label}<span class="vh"> for ${esc(r.task.label)}</span></span>${picker}${select}</div>`;
}

// An exact cost, as the provider reports it: $0.000123, $0.50.
const costText = (n: number): string => {
  if (n === 0) return "$0";
  const [whole, frac = ""] = n.toFixed(12).replace(/0+$/, "").split(".");
  return `$${whole}.${frac.padEnd(2, "0")}`;
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

// A reply longer than this shows its start, the rest collapsed.
const REPLY_SHOWN = 280;

// Try it's result under its row: the reply, who answered, the call's
// figures and the month's spend; or why it did not answer, with its fix.
export function renderTried(o: TryOutcome, input: PickerPageInput): string {
  const nameOf = (m: { provider: Provider; model: string }) => input.offered.find((x) => modelKey(x) === modelKey(m))?.name ?? input.nameOf?.(m) ?? m.model;
  const marked = (f: TryFailure) => (f.marked ? " Marked Failed when used." : "");
  // The provider's own words, collapsed.
  const replies = (fs: TryFailure[]) => {
    const said = fs.filter((f) => f.reply);
    return said.length ? `<details><summary>${esc(input.providerName(said[0]!.provider))}'s reply</summary>${said.map((f) => `<p>${esc(nameOf(f))}: ${esc(f.reply!)}</p>`).join("")}</details>` : "";
  };
  if (o.kind === "refused") {
    const both = o.failed.length > 1;
    const head = both ? "Main model and fallback both failed." : o.reason;
    const roles = both ? ["Main model", "Fallback"] : ["Model"];
    const failed = o.failed.length ? `<ul class="tr-fails">${o.failed.map((f, i) => `<li>${esc(roles[i] ?? "Model")} ${esc(nameOf(f))}: ${esc(f.reason)}${marked(f)}</li>`).join("")}</ul>` : "";
    const action = o.action ? `<p class="acts"><a class="btn small" href="${esc(o.action.href)}">${esc(o.action.label)}</a></p>` : "";
    return `<div class="result bad tr" role="alert"><p class="v">${ICON.bad}<span><strong>Not answered.</strong> ${esc(head)}</span></p>${failed}${action}${replies(o.failed)}</div>`;
  }
  const text = o.text ?? "";
  const reply = !text
    ? `<p class="tr-none">The reply had no text.</p>`
    : text.length <= REPLY_SHOWN
      ? `<p class="tr-reply">${esc(text)}</p>`
      : `<details class="tr-reply"><summary><span class="tr-start">${esc(text.slice(0, REPLY_SHOWN).trimEnd())}…</span><span class="tr-more">Show the whole reply</span></summary><p>${esc(text)}</p></details>`;
  const fell = o.mainFailed
    ? `<p class="tr-fell">Main model ${esc(nameOf(o.mainFailed))} failed: ${esc(o.mainFailed.reason)}${marked(o.mainFailed)}</p>`
    : "";
  const fact = (k: string, v: string) => `<div><dt>${k}</dt><dd class="num">${v}</dd></div>`;
  const n = (x: number) => x.toLocaleString("en-US");
  const month = `This month ${money(o.month.spentUsd)}${o.month.budgetUsd !== undefined ? ` of your ${budgetText(o.month.budgetUsd)} budget` : ""} · <a href="${USAGE_PATH}">Usage</a>`;
  const provider = input.providerName(o.model.provider);
  const about = [
    `It proves the pipeline every task's calls use: your key, the saved model, the fallback, the budget stop and the usage record. Not how well the task is done.`,
    `Prompt sent: ${o.task.sample}`,
    o.costReported ? `Tokens and cost are ${provider}'s own, from its reply.` : `${provider}'s reply gave no cost, so it is estimated at list price.`,
    ...(o.callId ? [`${provider}'s ID for the call: ${o.callId}`] : []),
  ];
  return `<div class="result ok tr" role="status"><p class="v">${ICON.ok}<span><strong>${esc(nameOf(o.model))}</strong> answered${o.picked ? ` with ${esc(o.picked)}` : ""} · ${o.role === "main" ? "main model" : "fallback"}</span></p>
${fell}${reply}
<dl class="tr-facts">${fact("Input", n(o.usage.input + o.usage.cacheWrite + o.usage.cacheWrite1h))}${fact("Cached", n(o.usage.cachedInput))}${fact("Output", n(o.usage.output))}${fact("Cost", `${costText(o.costUsd)}${o.costReported ? "" : " est."}`)}${fact("Time", seconds(o.durationMs))}</dl>
<p class="tr-month">${month}</p>
<details><summary>What this proves</summary>${about.map((a) => `<p>${esc(a)}</p>`).join("")}</details>${o.mainFailed ? replies([o.mainFailed]) : ""}</div>`;
}

function taskRow(r: TaskRoute, input: PickerPageInput, primary: boolean): string {
  const list = offeredFor(r.task, input.offered);
  const shown = shownFor(r);
  const need = rowNeed(r, list, shown, input);
  // Try it reads the saved models: a row with none has nothing to try.
  const canTry = Boolean(r.current || r.stopped?.fallback);
  const tryCell = canTry
    ? `<div class="t-try"><button type="submit" class="btn small" id="try-btn-${esc(r.task.id)}" formaction="${TASK_MODELS_PATH}/try" data-try aria-describedby="try-${esc(r.task.id)}">Try it</button></div>`
    : "";
  const tried = input.tried && input.tried.task?.id === r.task.id ? renderTried(input.tried, input) : "";
  const action = need.action?.(`btn small${primary ? " primary" : ""}`) ?? "";
  const tag = r.pending && !r.current ? `<span class="pill">Proposed</span>` : "";
  // The action goes with the note it fixes, and hides with it.
  const about = need.note.find((n) => n.about)?.about;
  const note = need.note.length ? `<p class="t-says">${need.note.map((n) => `<span${n.about ? ` data-about="${n.about}"` : ""}>${n.text}</span>`).join(" ")}</p>` : "";
  return `<li class="task" id="task-${esc(r.task.id)}" data-task="${esc(r.task.id)}"${need.blocked ? " data-blocked" : ""}>
<form method="post" action="${TASK_MODELS_PATH}/change" class="task-f">
<input type="hidden" name="task" value="${esc(r.task.id)}">
<div class="t-name"><span class="t">${esc(r.task.label)}</span><span class="t-tags"><span class="pill" title="Suggested strength">${r.task.tier}</span>${tag}</span></div>
${dropdown(r, "main", list, shown, input)}
${dropdown(r, "fallback", list, shown, input)}
${tryCell}
<div class="t-note">${note}${action ? `<span class="t-act"${about ? ` data-about="${about}"` : ""}>${action}</span>` : ""}<button type="submit" class="btn small nojs">Save</button></div>
<div class="try-out" id="try-${esc(r.task.id)}" aria-live="polite">${tried}</div>
</form></li>`;
}

// The one tap for free models, where tasks have no model and no proposal.
function freeTap(input: PickerPageInput, primary: boolean): string {
  const set = freeRoutes(input.offered, input.routes);
  if (!set.length) return "";
  const allFree = input.offered.filter((m) => m.state === "ready").every((m) => m.free);
  const why = allFree
    ? "Your Ready models are all free, so none is proposed."
    : `${set.length === 1 ? "One task has" : `${set.length} tasks have`} no proposed model. Your free models can take ${set.length === 1 ? "it" : "them"}.`;
  return `<div class="banner free-tap" role="note"><p>${esc(why)}</p>
<form method="post" action="${TASK_MODELS_PATH}/use-free" data-fetch data-rows><button type="submit" class="btn${primary ? " primary" : ""}">Use my free models for ${set.length === TASKS.length ? "every task" : set.length === 1 ? "1 task" : `${set.length} tasks`}</button></form>
<details><summary>Why free models are not proposed</summary><ul class="small">
<li>A free model is rate-limited, and its providers may log prompts.</li>
<li>The tap picks the cheapest free model of each task's strength, and another as its fallback.</li>
</ul></details></div>`;
}

// The line under the heading: how many tasks have a model, and what to do.
function finding(input: PickerPageInput): string {
  const n = input.routes.filter((r) => r.current || r.stopped?.fallback).length;
  const pending = input.routes.filter((r) => r.pending).length;
  if (n === TASKS.length && !pending) return "Every task has a model. Its fallback answers when the main model fails a call.";
  const has = n === 0 ? "No task has a model yet" : `${n} of ${TASKS.length} tasks have a model`;
  return pending ? `${has} · ${pending === 1 ? "1 proposal" : `${pending} proposals`} to accept` : `${has}. Each takes a Ready model of its strength.`;
}

const tabsLine = (): string =>
  `<nav class="tabs" aria-label="Models setup">${SETUP_TABS.map((t) => (t.href === TASK_MODELS_PATH ? `<span aria-current="page">${esc(t.label)}</span>` : `<a href="${t.href}">${esc(t.label)}</a>`)).join("")}</nav>`;

// The page's <main>, also what an in-place request gets back.
export function renderMain(input: PickerPageInput): string {
  const pending = input.routes.some((r) => r.pending);
  const free = freeRoutes(input.offered, input.routes).length > 0;
  // The one solid blue button: Accept, else the free tap, else the first
  // row's fix for a task with no model, else Next where there is one.
  const fixAt = pending || free ? -1 : input.routes.findIndex((r) => {
    const need = rowNeed(r, offeredFor(r.task, input.offered), shownFor(r), input);
    return need.blocked && need.action?.("btn") ;
  });
  const rows = input.routes.map((r, i) => taskRow(r, input, i === fixAt)).join("\n");
  const accept = pending
    ? `<form method="post" action="${TASK_MODELS_PATH}/accept" data-fetch data-rows><button type="submit" class="btn primary">Accept all with one tap</button></form>`
    : "";
  const terms = input.freeTerms && input.offered.some((m) => m.free && m.state === "ready")
    ? `<li>${esc(input.freeTerms.text)} ${input.freeTerms.links.map((l) => newTab(l, "ext")).join(" · ")}</li>`
    : "";
  const help =
    input.viewer === "friend"
      ? `<form method="post" action="${TASK_MODELS_PATH}/help" data-fetch><button type="submit" class="btn">Ask Admin for help</button></form>`
      : "";
  const banner = `${input.problem ? `<div class="banner warn" role="alert" tabindex="-1">${esc(input.problem)}</div>` : ""}${input.said ? `<div class="banner ok" role="status" tabindex="-1">${esc(input.said)}</div>` : ""}`;
  const primaryNext = !pending && !free && fixAt === -1;
  const next = `${help}${nextAction(TASK_MODELS_PATH, primaryNext ? "btn primary" : "btn")}`;
  return `<div class="title-row"><h1>Models</h1>${modelsSubtabs("setup")}</div>
${tabsLine()}
<div data-part="banner">${banner}</div>
<section class="block" aria-labelledby="h-tasks">
<div class="block-head"><h2 id="h-tasks">Model for each task</h2><p class="sub">${esc(finding(input))}</p>${accept ? `<div class="head-act">${accept}</div>` : ""}</div>
${freeTap(input, free && !pending)}
<div class="panel">
<div class="tasks-head" aria-hidden="true"><span>Task</span><span>Main model</span><span>Fallback</span><span></span></div>
<ul class="tasks" aria-label="Tasks">
${rows}
</ul>
<div class="tasks-foot"><details><summary>How it works</summary><ul>
<li>Each list holds your Ready models of the task's strength, the cheapest first. No test needed.</li>
<li>When the main model fails a call, its fallback answers it, and the model's row on Providers and models says why.</li>
<li>Strength comes from the input price per million tokens: Smallest under $0.50, Middle to $2.50.</li>
<li>A free model is never proposed. Choose it in its list${free ? ", or with the one tap" : ""}.</li>
<li>Try it sends one short made-up prompt to the task's saved model, its fallback if that fails. It costs a real call, counts toward your budget and never changes your choice.</li>
${terms}
</ul></details></div>
</div>
<div class="savebar" id="savebar" role="region" aria-label="Unsaved changes" hidden><p class="sb-n" aria-live="polite"></p><p class="sb-err" role="alert"></p><button type="button" class="btn" data-undo>Undo</button><button type="button" class="btn primary" data-save>Save</button></div>
</section>
${next ? `<div class="next-row">${next}</div>` : ""}`;
}

export function renderPickerPage(input: PickerPageInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Models · Model for each task · Chief of staff</title>
<link rel="icon" href="data:,">
<script>document.documentElement.className += " js";</script>
<style>${PAGE_STYLE}${CSS}</style>
</head>
<body>
<main class="screen" id="screen">
${renderMain(input)}
</main>
<script>${PICKER_SCRIPT}</script>
</body>
</html>`;
}

const CSS = `
.vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.tasks-head, .task-f { display: grid; grid-template-columns: minmax(170px, .9fr) minmax(0, 1.5fr) minmax(0, 1.5fr) 72px; gap: 8px 16px; }
.tasks-head { padding: 10px var(--card-pad); font-size: var(--fs-small); color: var(--muted); border-bottom: 1px solid var(--border); }
.task { border-bottom: 1px solid var(--rule); }
.tasks > .task:last-child { border-bottom: 0; }
.task-f { padding: 12px var(--card-pad); align-items: center; }
.t-name { display: grid; gap: 4px; min-width: 0; align-self: center; }
.t-name .t { font-size: var(--fs-body); line-height: 20px; }
.t-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.t-note [data-about][hidden] { display: none; }
.t-says { margin: 0; }
.t-pick { min-width: 0; }
.pl { display: none; font-size: var(--fs-small); color: var(--muted); margin-bottom: 4px; }
.t-note { grid-column: 2 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font-size: var(--fs-small); color: var(--text); }
.t-note:not(:has(> :not(.nojs))), .js .t-note[data-quiet] { display: none; }
.js .t-note .nojs, .js .nsel { display: none; }
html:not(.js) .pick { display: none; }
html:not(.js) .t-note { display: flex; }
.nsel { width: 100%; min-height: 40px; padding: 0 10px; border: 1px solid var(--control); border-radius: var(--radius-control); background: var(--surface); color: var(--text); font: inherit; font-size: 14px; }
.pick { position: relative; min-width: 0; }
.pick-btn { width: 100%; min-height: 48px; display: flex; align-items: center; gap: 10px; padding: 5px 10px 5px 12px; border: 1px solid var(--control); border-radius: var(--radius-control); background: var(--surface); text-align: left; transition: border-color var(--t); }
.pick-btn:hover { border-color: var(--control-hover); }
.pick-btn[aria-expanded="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); } /* taste-skill-ignore: focus ring, not a shadow */
.pick-btn[disabled] { cursor: default; background: transparent; border-style: dashed; border-color: var(--control); }
.pick-btn .chev { flex: none; display: inline-flex; color: var(--muted); }
.pick-btn .chev svg { width: 12px; height: 12px; }
.task[data-dirty] .pick-btn[data-changed] { border-color: var(--accent); }
.pv { flex: 1; min-width: 0; }
.ov { display: grid; min-width: 0; }
.ov-l1 { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; line-height: 20px; }
.ov-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ov-ph { color: var(--muted); }
.ov-pr { margin-left: auto; flex: none; font-size: 13px; color: var(--muted); }
.ov-l1 .pill.free { margin-left: auto; }
.ov-l2 { display: flex; gap: 8px; min-width: 0; font-size: 12px; line-height: 17px; color: var(--muted); }
.ov-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ov-x { flex: none; }
.ov-l2 .pill { height: 18px; font-size: 12px; padding: 0 6px; }
.pick-pop { position: absolute; z-index: 30; top: calc(100% + 6px); left: 0; width: max(100%, 340px); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-card); box-shadow: 0 10px 28px var(--shadow); padding: 8px; } /* taste-skill-ignore: a menu that floats */
.pick-q { width: 100%; height: 36px; padding: 0 10px; border: 1px solid var(--control); border-radius: var(--radius-control); background: var(--surface); font-size: 14px; margin-bottom: 6px; }
.pick-q::-webkit-search-cancel-button { display: none; }
.pick-q:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); } /* taste-skill-ignore: focus ring */
.pick-pop ul { max-height: 312px; overflow-y: auto; margin: 0 -4px; padding: 0 4px; }
.pick-pop li[role="option"] { padding: 7px 8px; border-radius: 4px; cursor: pointer; }
.pick-pop li[role="option"]:hover { background: var(--raised); }
.pick-pop li[role="option"][aria-selected="true"] { background: var(--active); }
.pick-pop li[role="option"].on { box-shadow: inset 0 0 0 2px var(--accent); } /* taste-skill-ignore: the keyboard's place */
.pick-pop li[role="option"][hidden] { display: none; }
.pick-group { padding: 6px 8px 2px; font-size: 12px; color: var(--muted); }
.pick-none { padding: 10px 8px; font-size: var(--fs-small); color: var(--muted); }
.tasks-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; padding: 14px var(--card-pad) 16px; border-top: 1px solid var(--border); }
.tasks-foot details { font-size: var(--fs-small); color: var(--muted); }
.tasks-foot details ul { margin-top: 8px; padding-left: 18px; list-style: disc; display: grid; gap: 4px; max-width: 70ch; }
.free-tap { margin: 0 0 16px; display: grid; gap: 10px; }
.free-tap form { display: block; }
.free-tap details ul { margin-top: 6px; padding-left: 18px; list-style: disc; }
.savebar { position: sticky; bottom: 16px; z-index: 20; margin-top: 16px; display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-card); box-shadow: 0 10px 28px var(--shadow); } /* taste-skill-ignore: a bar that floats over the list */
.savebar .sb-n { margin-right: auto; font-size: 14px; }
.savebar .sb-err { color: var(--negative); font-size: var(--fs-small); }
.savebar .sb-err:empty { display: none; }
.savebar[data-done] .btn { display: none; }
.savebar[data-done] .sb-n { color: var(--positive); }
.t-try { align-self: center; justify-self: end; }
.t-try .btn[aria-busy="true"] { gap: 8px; }
.try-out { grid-column: 2 / -1; min-width: 0; }
.try-out:empty { display: none; }
.tr { gap: 10px; }
.tr .v strong { font-weight: 700; }
.tr-fell { margin: 0; font-size: var(--fs-small); color: var(--pill-warning-ink); }
.tr-reply { margin: 0; padding: 10px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-control); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.5; max-width: 72ch; }
details.tr-reply summary { color: inherit; width: auto; font-size: 14px; list-style: none; }
details.tr-reply summary::-webkit-details-marker { display: none; }
details.tr-reply .tr-more { display: block; margin-top: 6px; color: var(--accent); font-size: var(--fs-small); }
details.tr-reply[open] summary { display: none; }
details.tr-reply p { margin: 0; color: inherit; font-size: 14px; }
.tr-none { margin: 0; color: var(--muted); font-size: var(--fs-small); }
.tr-facts { display: flex; flex-wrap: wrap; gap: 6px 20px; margin: 0; }
.tr-facts div { display: grid; gap: 1px; }
.tr-facts dt { font-size: 12px; color: var(--muted); }
.tr-facts dd { margin: 0; font-size: 14px; }
.tr-month { margin: 0; font-size: var(--fs-small); color: var(--muted); }
.tr-fails { margin: 0; padding-left: 18px; list-style: disc; display: grid; gap: 4px; font-size: var(--fs-small); }
.tr-wait { display: flex; align-items: center; gap: 8px; margin: 0; font-size: var(--fs-small); color: var(--muted); }
.next-row { gap: 10px; }
.block-head .head-act { margin-left: auto; align-self: center; }
.block-head .head-act form { display: block; }
.banner[tabindex]:focus { outline: none; }
@media (max-width: 860px) {
  .tasks-head { display: none; }
  .task-f { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); padding: 14px 16px; }
  .t-name { grid-column: 1 / -1; }
  .task-f:has(.t-try) .t-name { grid-column: 1; }
  .t-try { grid-column: 2; grid-row: 1; }
  .block-head .head-act { margin-left: 0; }
  .t-note, .try-out { grid-column: 1 / -1; }
  .pl { display: block; }
}
@media (max-width: 640px) {
  .task-f { grid-template-columns: minmax(0, 1fr) auto; gap: 10px; }
  .t-pick { grid-column: 1 / -1; }
  .pick-pop { width: 100%; }
  .pick-pop ul { max-height: 50vh; }
  .tasks-foot { padding: 14px 16px; }
  .savebar { bottom: 12px; padding: 10px 12px; }
  .savebar .sb-n { flex: 1 1 100%; }
  .savebar .btn { flex: 1; }
}
`;

const ROUTE = new RegExp(`^${TASK_MODELS_PATH}(?:/(accept|change|use-free|help|try))?$`);

export const isTaskModelsPath = (pathname: string): boolean => ROUTE.test(pathname);

function problemText(task: Task | undefined, problem: ChangeProblem): string {
  const text: Record<ChangeProblem, string> = {
    no_such_task: "There is no such task.",
    no_main: "Choose a main model first.",
    not_your_model: "That model is not ready. Choose one from its list.",
    wrong_strength: `This task takes only ${task?.tier ?? "its strength's"} models. Choose one from its list.`,
    same_model: "The fallback must be another model than the main one.",
  };
  return task ? `${task.label}: ${text[problem]}` : text[problem];
}

const PROBLEMS = new Set<string>(["no_such_task", "no_main", "not_your_model", "wrong_strength", "same_model"]);

// What a page shows once, after a redirect, read from its address.
function flashFrom(params: URLSearchParams): { said?: string; problem?: string } {
  const problem = params.get("problem") ?? "";
  if (PROBLEMS.has(problem)) return { problem: problemText(taskById(params.get("task") ?? ""), problem as ChangeProblem) };
  const saved = (params.get("saved") ?? "").split(",").map((t) => taskById(t)).filter((t): t is Task => t !== undefined);
  const said = [saved.length ? `Saved: ${saved.length === 1 ? saved[0]!.label : `${saved.length} tasks`}.` : "", tapSaid(params)].filter(Boolean).join(" ");
  return said ? { said } : {};
}

// What a tap says it did, read from the address.
function tapSaid(params: URLSearchParams): string {
  const n = (k: string) => Number.parseInt(params.get(k) ?? "", 10);
  if (params.has("accepted")) return n("accepted") > 0 ? `Accepted: ${n("accepted")} ${n("accepted") === 1 ? "task uses its" : "tasks use their"} proposed models.` : "There was nothing to accept.";
  if (params.has("free")) return n("free") > 0 ? `${n("free")} ${n("free") === 1 ? "task now uses a free model" : "tasks now use your free models"}. Change any task below.` : "There was nothing to set.";
  if (params.get("asked") === "1") return "Sent to Admin: this item's name and its reason only.";
  return "";
}

// Every route is scoped to the signed-in user.
export async function handleTaskModels(
  request: Request,
  input: { db: D1Database; plugins: PluginRegistry; userId: string; viewer: Viewer; now: Date },
): Promise<Response> {
  const { db, plugins, userId, viewer, now } = input;
  const url = new URL(request.url);
  const [, verb] = ROUTE.exec(url.pathname) ?? [];
  const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
  const state = async (flash: { said?: string; problem?: string }): Promise<PickerPageInput> => {
    const { offered, routes } = await readTaskRoutes(db, plugins, userId);
    const providerName = (p: Provider) => plugins[p]?.connect.guide.short ?? PROVIDER_NAMES[p];
    const noToolUse = (m: Ref) => plugins[m.provider]?.connect.noToolUse?.(m.model) !== undefined;
    const freeTerms = offered.filter((m) => m.free && m.state === "ready").map((m) => plugins[m.provider]?.connect.freeModelTerms).find(Boolean);
    const accountSettings = (p: Provider) => plugins[p]?.connect.guide.accountSettings;
    const credits = (p: Provider) => plugins[p]?.connect.guide.credits;
    // Only a strength with fewer than two Ready models links to what makes more Ready.
    const short = TASKS.some((t) => offeredFor(t, offered).length < 2);
    const [nameOf, toReady] = await Promise.all([readModelNames(db), short ? readToReady(db, plugins, userId) : undefined]);
    return { viewer, offered, routes, providerName, noToolUse, freeTerms, accountSettings, credits, nameOf, toReady, ...flash };
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  // After an action: in place, the page's <main> with what it said; without
  // the script, a redirect to the page with it in the address.
  const done = async (flash: { said?: string; problem?: string }, query: Record<string, string>, status = 200): Promise<Response> => {
    if (wantsJson) return flash.problem ? json({ problem: flash.problem }, status) : json({ main: renderMain(await state(flash)) });
    return new Response(null, { status: 303, headers: { location: `${url.origin}${TASK_MODELS_PATH}?${new URLSearchParams(query)}` } });
  };

  if (!verb) {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    // The account line's credit figure, live, before the lists are worked out.
    const first = PROVIDERS.find((p) => plugins[p]);
    if (first) await readAccountLive(db, plugins[first]!, userId);
    return new Response(renderPickerPage(await state(flashFrom(url.searchParams))), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  // A form posted from another site is refused.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return new Response(null, { status: 403 });
  const form = await request.formData();
  const field = (name: string): string => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };

  // The rows the user changed: /change's own, and those sent with a tap.
  const changes: TaskChange[] = [...new Set(form.getAll("task").filter((t): t is string => typeof t === "string"))].map((task) => ({ task, main: field(`main.${task}`), fallback: field(`fallback.${task}`) }));
  const saved: Record<string, string> = changes.length ? { saved: changes.map((c) => c.task).join(",") } : {};
  const refuse = (r: ChangeRefusal) => done({ problem: problemText(taskById(r.task), r.problem) }, { problem: r.problem, task: r.task }, 400);
  const said = (query: Record<string, string>) => done(flashFrom(new URLSearchParams(query)), query);

  if (verb === "accept") {
    const n = await acceptProposals(db, plugins, userId, now, changes);
    return typeof n === "number" ? said({ ...saved, accepted: String(n) }) : refuse(n);
  }
  if (verb === "use-free") {
    const set = await useFreeModels(db, plugins, userId, now, changes);
    return Array.isArray(set) ? said({ ...saved, free: String(set.length) }) : refuse(set);
  }
  // Try it: one real call on the task's saved models, which it never writes.
  if (verb === "try") {
    const task = field("task");
    const tried = await tryTask(db, plugins, userId, task, () => now);
    if (wantsJson) return json({ task, tried: renderTried(tried, await state({})) });
    return new Response(renderPickerPage({ ...(await state({})), tried }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (verb === "change") {
    const refused = changes.length ? await changeTasks(db, plugins, userId, changes, now) : { task: "", problem: "no_such_task" as const };
    return refused ? refuse(refused) : said(saved);
  }
  // "Ask Admin for help": the item's name only.
  if (viewer !== "friend") return new Response(null, { status: 403 });
  await db
    .prepare("INSERT INTO help_requests (user_id, item, reason, at) VALUES (?, ?, ?, ?)")
    .bind(userId, "Model for each task", "asked for help choosing a model for each task", now.toISOString())
    .run();
  const asked = { asked: "1" };
  return wantsJson ? json({ said: flashFrom(new URLSearchParams(asked)).said }) : said(asked);
}
