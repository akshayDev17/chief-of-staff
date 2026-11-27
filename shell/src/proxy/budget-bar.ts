// The OpenRouter budget bar (AKS-136, reworked for OpenRouter: the owner,
// 2026-11-27, "rework the bar for openrouter"; design-v3 1.8). One bar for
// the month, in three parts:
//
//   solid      spent, as OpenRouter reports it: the app's key's own figure
//              for this UTC month (GET /api/v1/key, `usage_monthly`, plus
//              `byok_usage_monthly`), read server side with the key in the
//              user's vault;
//   striped    counted by the app, not in OpenRouter's figure yet: what the
//              ledger counted this month beyond that figure. No OpenRouter
//              page says how soon a call shows in the key's figures, so the
//              stripe stays: usually $0, it is also where calls made with an
//              earlier key land after the user connected again;
//   empty      what is left of the user's monthly budget.
//
// The app's own count, which stops calls at the budget, is always written
// under the bar, and so is any gap between it and OpenRouter's figure. When
// the key has its own credit limit on OpenRouter, that is written too: it can
// refuse calls before the budget is spent.
//
// Hover, tap or focus on a part says what it is, with a link to OpenRouter's
// Activity page, which filters usage by key.

import { BUDGETS_PATH } from "../paths";
import { esc } from "../prices/page";
import { keyLinks, OPENROUTER_ACTIVITY_URL, readKeyUsage, type KeyUsage } from "../providers/openrouter";
import type { SecretStore } from "../providers/secrets";
import { ProviderRefusal, type ConnectionFields } from "./plugin";

// OpenRouter's figure for the key, or the plain reason it could not be read.
export type KeyFigure = { usage: KeyUsage; readAt: string } | { unread: string };

// Reads the key's own figures with the key from the user's vault. Never
// throws: a missing key, a vault the app cannot open, or OpenRouter refusing
// or not answering each give a plain reason instead.
export async function readKeyFigure(secrets: SecretStore, userId: string, now: Date, fetcher: typeof fetch = fetch): Promise<KeyFigure> {
  let key: string | undefined;
  try {
    key = await secrets.read(userId, "openrouter", "key");
  } catch {
    return { unread: "the app could not open your vault" };
  }
  if (!key) return { unread: "the app holds no OpenRouter key for you" };
  try {
    return { usage: await readKeyUsage(key, fetcher), readAt: now.toISOString() };
  } catch (e) {
    if (!(e instanceof ProviderRefusal)) return { unread: "OpenRouter did not answer" };
    if (e.refusal.status === 401) return { unread: "OpenRouter no longer accepts the key" };
    if (e.refusal.errorName === "no_usage") return { unread: "OpenRouter's reply held no monthly figure" };
    return { unread: `OpenRouter refused the request (status ${e.refusal.status})` };
  }
}

export interface BarParts {
  // OpenRouter's figure, 0 when it could not be read.
  reported: number;
  // The ledger's count beyond OpenRouter's figure (all of it when unread).
  extra: number;
  // What is left of the budget after the larger of the two counts.
  left: number;
  // The larger of the two counts: what the bar shows as spent.
  spent: number;
  // How far the spend is past the budget, else 0.
  over: number;
}

// How far one count is above the other, 0 when under half a cent.
const beyond = (usd: number, than: number): number => (usd - than >= 0.005 ? usd - than : 0);

export function barParts(budgetUsd: number, ledgerUsd: number, key: KeyFigure): BarParts {
  const reported = "usage" in key ? key.usage.monthlyUsd : 0;
  const extra = "usage" in key ? beyond(ledgerUsd, reported) : ledgerUsd;
  const spent = reported + extra;
  return { reported, extra, spent, left: Math.max(0, budgetUsd - spent), over: Math.max(0, spent - budgetUsd) };
}

export const money = (usd: number): string => (usd > 0 && usd < 0.005 ? "under $0.01" : `$${usd.toFixed(2)}`);
export const budgetText = (usd: number): string => `$${usd.toLocaleString("en-US", { minimumFractionDigits: usd % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;

export interface BudgetBarInput {
  budgetUsd: number;
  ledgerUsd: number;
  key: KeyFigure;
  // Where the budget is changed: the Budgets page, or its own field when the
  // bar is on that page.
  budgetHref?: string;
  // The user's OpenRouter connection, for the links to the key's page there.
  connection?: ConnectionFields;
}

interface Region {
  id: "real" | "est" | "left";
  name: string;
  usd: number;
  what: string;
  links: Array<{ label: string; href: string; outside: boolean }>;
}

const ACTIVITY = { label: "OpenRouter's Activity page", href: OPENROUTER_ACTIVITY_URL, outside: true };

function regions(input: BudgetBarInput, p: BarParts): Region[] {
  const { key } = input;
  const read = "usage" in key;
  const budgetLink = { label: "Change the budget", href: input.budgetHref ?? BUDGETS_PATH, outside: false };
  return [
    {
      id: "real",
      name: "Spent, as OpenRouter reports it",
      usd: p.reported,
      what: read
        ? `OpenRouter's own figure for the “Chief of staff” key this month, read at ${hhmm(key.readAt)}. It is the app's own key, so it counts only this app's calls.`
        : `OpenRouter's own figure could not be read just now: ${key.unread}.`,
      links: [{ ...ACTIVITY, label: "See it on OpenRouter's Activity page, filtered by the “Chief of staff” key" }],
    },
    {
      id: "est",
      name: read ? "Counted by the app, not in OpenRouter's figure yet" : "Counted by the app",
      usd: p.extra,
      what: read
        ? "Calls the app counted this month that OpenRouter's figure for this key does not include: OpenRouter may not have counted them yet, or they were made with an earlier key, before you connected again. Each is OpenRouter's own cost for that call, from its reply, or its list price when the reply reported none."
        : "Every call the app counted this month, each at OpenRouter's own cost from its reply, or at list price when the reply reported none.",
      links: [{ ...ACTIVITY, label: "Check the calls on OpenRouter's Activity page" }],
    },
    {
      id: "left",
      name: "Budget left",
      usd: p.left,
      what: `Your monthly budget of ${budgetText(input.budgetUsd)}, less what is spent. When it is used up, calls stop until the 1st.`,
      links: [budgetLink, ACTIVITY],
    },
  ];
}

const linkHtml = (l: Region["links"][number]) =>
  `<a href="${esc(l.href)}"${l.outside ? ' target="_blank" rel="noopener noreferrer"' : ""}>${esc(l.label)}</a>`;

// The bar as HTML, with its key, its sources and the key's own limit.
// Needs BAR_CSS on the page, and BAR_JS for tapping.
export function renderBudgetBar(input: BudgetBarInput): string {
  const p = barParts(input.budgetUsd, input.ledgerUsd, input.key);
  const scale = Math.max(input.budgetUsd, p.spent);
  const all = regions(input, p);
  const segments = all
    .filter((r) => r.usd > 0)
    .map((r) => {
      const width = r.id === "left" ? "" : ` style="width:${((r.usd / scale) * 100).toFixed(2)}%"`;
      const body = `<strong>${esc(r.name)}: ${money(r.usd)}</strong><br>${esc(r.what)}<span class="bb-go">${r.links.map(linkHtml).join(" · ")}</span>`;
      return `<button type="button" class="bb-seg bb-${r.id}"${width} data-region="${r.id}" aria-label="${esc(`${r.name}: ${money(r.usd)}`)}" aria-describedby="bbt-${r.id}" aria-expanded="false"></button><div class="bb-tip bb-tip-${r.id}" id="bbt-${r.id}"><div>${body}</div></div>`;
    })
    .join("");
  const key = all.map((r) => `<li><span class="bb-sw bb-${r.id}" aria-hidden="true"></span>${esc(r.name)} ${money(r.usd)}</li>`).join("");
  const k = input.key;
  const ahead = "usage" in k ? beyond(p.reported, input.ledgerUsd) : 0;
  const spentOf = `${money(p.spent)} of ${budgetText(input.budgetUsd)} ${ahead ? "by OpenRouter's figure" : "by the app's count"}`;
  const head = p.over ? `${spentOf} · over by ${money(p.over)}` : `${spentOf} · ${money(p.left)} left`;
  const gap = ahead ? ` OpenRouter's figure is ${money(ahead)} more than the app's own count; the bar shows the larger.` : "";
  const source =
    "usage" in k
      ? `Source: OpenRouter's own figure for the Chief of staff key, ${money(p.reported)} at ${hhmm(k.readAt)}, plus what the app counted beyond it. The app's own count this month, which stops calls at the budget: ${money(input.ledgerUsd)}.${gap}`
      : `OpenRouter's own figure could not be read just now (${esc(k.unread)}), so the bar shows the app's own count this month, which stops calls at the budget: ${money(input.ledgerUsd)}.`;
  const keyPages = keyLinks(input.connection).map((l) => linkHtml({ ...l, outside: true })).join(" · ");
  let limit = "";
  if ("usage" in k && k.usage.limitUsd !== undefined) {
    const { limitUsd, limitRemainingUsd, limitReset } = k.usage;
    const resets = limitReset ? ` (resets ${esc(limitReset)})` : "";
    const remaining = limitRemainingUsd !== undefined ? `, ${money(limitRemainingUsd)} left` : "";
    const first = limitRemainingUsd !== undefined && limitRemainingUsd < p.left;
    const sentence = `The key's own credit limit on OpenRouter: ${budgetText(limitUsd)}${resets}${remaining}. OpenRouter refuses calls at it${first ? ", before your budget is used up" : ", whatever is left of your budget"}; change it there: ${keyPages}.`;
    limit = first ? `<p class="bb-note bb-warn" role="note">${sentence}</p>` : `<p class="bb-note small muted">${sentence}</p>`;
  }
  return `<div class="bb" data-budget-bar>
<div class="bb-head"><strong>OpenRouter this month</strong><span class="small">${head}</span></div>
<div class="bb-bar" role="group" aria-label="OpenRouter budget this month: ${esc(head)}">${segments}</div>
<ul class="bb-key">${key}</ul>
<p class="bb-note small muted">Hover over, tap or tab to a part of the bar to see what it is and where it comes from.</p>
<p class="bb-note small muted">${source}</p>
${limit}</div>`;
}

export const BAR_CSS = `
.bb { margin: 8px 0 4px; }
.bb-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; align-items: baseline; }
.bb-bar { position: relative; display: flex; height: 24px; margin: 8px 0 6px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); }
.bb-seg { appearance: none; border: 0; margin: 0; padding: 0; height: 100%; cursor: pointer; font: inherit; color: inherit; flex: 0 1 auto; min-width: 16px; }
.bb-seg:first-of-type { border-top-left-radius: 999px; border-bottom-left-radius: 999px; }
.bb-seg:last-of-type { border-top-right-radius: 999px; border-bottom-right-radius: 999px; }
.bb-seg.bb-left { flex: 1 1 auto; }
.bb-real { background: var(--accent); }
.bb-est { background: repeating-linear-gradient(135deg, color-mix(in oklab, var(--accent) 55%, var(--card)) 0 2px, color-mix(in oklab, var(--accent) 18%, var(--card)) 2px 6px); }
.bb-left { background: transparent; }
.bb-seg:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; position: relative; z-index: 1; }
.bb-tip { display: none; position: absolute; left: 0; right: 0; top: 100%; z-index: 5; padding-top: 6px; }
.bb-tip > div { padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: var(--text); font-size: .85rem; line-height: 1.45; box-shadow: 0 4px 14px rgba(0, 0, 0, .12); overflow-wrap: anywhere; }
.bb-go { display: block; margin-top: 4px; }
@media (hover: hover) { .bb-seg:hover + .bb-tip, .bb-tip:hover { display: block; } }
.bb-seg[aria-expanded="true"] + .bb-tip { display: block; }
.bb-key { display: flex; flex-wrap: wrap; gap: 4px 14px; list-style: none; margin: 0; padding: 0; font-size: .85rem; }
.bb-key li { display: flex; align-items: center; gap: 6px; }
.bb-sw { display: inline-block; width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--line); flex: none; }
.bb-note { margin: 6px 0 0; overflow-wrap: anywhere; }
.bb-warn { font-size: .85rem; padding: 6px 10px; border: 1px solid var(--warn); border-radius: 10px; background: var(--warn-soft); }
`;

// Tapping a part opens its label and tapping it again, elsewhere, or Escape
// closes it. Keyboard focus on a part opens its label too, and it stays open
// while focus moves into the label's links; hover needs no script (BAR_CSS).
// It wires every bar on the page, and `cosBudgetBars()` wires again any bar
// a page swapped in since (Budgets sets and clears in place); a bar already
// wired is left as it is.
export const BAR_JS = `
function cosBudgetBars() { document.querySelectorAll("[data-budget-bar]").forEach(function (bar) {
  if (bar.hasAttribute("data-wired")) return;
  bar.setAttribute("data-wired", "");
  var segs = Array.prototype.slice.call(bar.querySelectorAll(".bb-seg"));
  function show(id) { segs.forEach(function (s) { s.setAttribute("aria-expanded", String(s.getAttribute("data-region") === id)); }); }
  function opened() { return segs.filter(function (s) { return s.getAttribute("aria-expanded") === "true"; })[0]; }
  function within(s, n) { return n === s || s.nextElementSibling.contains(n); }
  segs.forEach(function (s) {
    s.addEventListener("click", function () { show(s.getAttribute("aria-expanded") === "true" ? "" : s.getAttribute("data-region")); });
    s.addEventListener("focus", function () { if (s.matches(":focus-visible")) show(s.getAttribute("data-region")); });
  });
  bar.addEventListener("focusout", function (e) { var s = opened(); if (s && e.relatedTarget && !within(s, e.relatedTarget)) show(""); });
  document.addEventListener("click", function (e) { if (!bar.contains(e.target)) show(""); });
  bar.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var s = opened();
    if (s && s.nextElementSibling.contains(document.activeElement)) s.focus();
    show("");
  });
}); }
cosBudgetBars();
`;
