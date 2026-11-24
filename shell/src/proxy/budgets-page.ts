// Models › Setup › Budgets, rendered on the server (design T02 / T12): one
// card per provider the user has connected, each with its monthly budget.
//
// Each card suggests a monthly value with its basis, marked "estimate" with
// its "checked on" date (the date the prices it uses were read), worked out
// from the list price of the dearest model the user picked there and the
// design's tokens per application (budgets.ts) at the volume the user plans.
// The user accepts it with one tap or types their own; until then the card
// says the provider's models cannot be called. Pages not built yet (Usage,
// Providers, Add a model, Model for each task) are named but not linked.

import { esc, nbDate, PAGE_CSS } from "../prices/page";
import type { Provider } from "../prices/types";
import {
  DEFAULT_APPLICATIONS_A_DAY,
  parseBudget,
  pickedModels,
  readBudget,
  setBudget,
  suggestBudget,
  type Budget,
  type Suggestion,
} from "./budgets";
import { connectedProviders } from "./connections";
import { monthSpend } from "./ledger";
import { PROVIDER_NAMES } from "./proxy";

export const BUDGETS_PATH = "/models/setup/budgets";

export interface ProviderBudgetCard {
  provider: Provider;
  budget?: Budget;
  spentThisMonth: number;
  suggestion?: Suggestion;
}

export interface BudgetsPageInput {
  cards: ProviderBudgetCard[];
  applicationsADay: number;
  // A plain message after a refused form, shown above the cards.
  problem?: string;
}

const dollars = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const cents = (n: number) => `$${n.toFixed(2)}`;

function card(c: ProviderBudgetCard, applicationsADay: number): string {
  const name = PROVIDER_NAMES[c.provider];
  const s = c.suggestion;
  const suggestion = s
    ? `<p class="small muted">Suggested · <span class="pill warn">estimate</span> · checked on ${nbDate(s.checkedOn)}</p>
<p class="big">about ${dollars(s.monthlyUsd)} a month</p>
<p class="small">Basis: ${applicationsADay} application${applicationsADay === 1 ? "" : "s"} a day, if this provider carried every task, at ${esc(s.model)}'s list prices from the app's price table and the design's tokens per application. Replaced by the figures measured in practice mode.</p>`
    : `<p class="small muted">No suggestion yet: it is worked out from the list price of a model you pick at this provider (Add a model).</p>`;
  const set = c.budget
    ? `<p class="ok-line">Budget set: ${dollars(c.budget.monthlyUsd)} a month · ${cents(c.spentThisMonth)} spent since the 1st</p>`
    : "";
  const unset = c.budget ? "" : `<p class="small muted">Until it is set, this provider's models cannot be called.</p>`;
  const hidden = `<input type="hidden" name="provider" value="${c.provider}">
<input type="hidden" name="per_day" value="${applicationsADay}">`;
  const accept = s
    ? `<form method="post" action="${BUDGETS_PATH}">
${hidden}
<button type="submit" class="btn small" name="accept" value="${s.monthlyUsd}">Accept the suggestion</button>
</form>`
    : "";
  return `<section class="card"><h3>${name}</h3>
${set}
${suggestion}
<div class="row">
${accept}
<form class="row" method="post" action="${BUDGETS_PATH}">
${hidden}
<label class="visually-hidden" for="amount-${c.provider}">Your own monthly budget for ${name}, in dollars</label>
<input class="f" id="amount-${c.provider}" name="amount" inputmode="decimal" style="max-width:9em" placeholder="or type your own">
<button type="submit" class="btn small secondary">Set</button>
</form>
</div>
${unset}
</section>`;
}

export function renderBudgetsPage(input: BudgetsPageInput): string {
  const cards = input.cards.length
    ? `<div class="grid c2">${input.cards.map((c) => card(c, input.applicationsADay)).join("\n")}</div>`
    : `<p>No provider is connected yet. Each provider you connect gets its budget here.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Models · Budgets · Chief of staff</title>
<style>${PAGE_CSS}${CSS}</style>
</head>
<body>
<main class="screen">
<h1>Models</h1>
<div class="subtabs"><span class="on">Setup</span><span aria-disabled="true">Usage</span></div>
<p class="small" style="margin:-4px 0 10px">Providers · <strong>Budgets</strong> · Add a model · Model for each task</p>
<h2>Budgets, one per provider</h2>
<p>Each provider bills you for the month, so each gets its own monthly budget, counted from the 1st. When one is spent, calls to that provider stop until the 1st; a task's fallback on another provider carries on within that provider's own budget.</p>
${input.problem ? `<div class="banner warn" role="alert">${esc(input.problem)}</div>` : ""}
<form class="row" method="get" action="${BUDGETS_PATH}" style="margin:8px 0">
<label class="small" for="per-day">Applications a day you plan</label>
<input class="f" id="per-day" name="per_day" inputmode="numeric" style="max-width:5em" value="${input.applicationsADay}">
<button type="submit" class="btn small secondary">Work out</button>
</form>
${cards}
<p class="small muted">A budget is any amount more than $0 a month.</p>
</main>
</body>
</html>`;
}

const CSS = `
.grid { display: grid; gap: 12px; grid-template-columns: 1fr; }
@media (min-width: 760px) { .grid.c2 { grid-template-columns: 1fr 1fr; } }
.grid > .card { margin-top: 0; }
.card h3 { margin: 10px 0 6px; }
.big { font-size: 1.6rem; font-weight: 500; line-height: 1.1; margin: 4px 0; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.subtabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
.subtabs > span { padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; font-size: .85rem; background: var(--card); }
.subtabs > span.on { border-color: var(--accent); }
.subtabs > span[aria-disabled] { color: var(--muted); }
.btn { display: inline-flex; align-items: center; font: inherit; font-weight: 500; font-size: .9rem; padding: 4px 10px; min-height: 30px;
  border-radius: 10px; border: 1px solid var(--accent); background: var(--accent); color: var(--card); cursor: pointer; }
.btn.secondary { background: var(--card); color: var(--accent); }
.btn:focus-visible, input.f:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input.f { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--text); width: 100%; }
.ok-line { color: var(--ok); font-weight: 500; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

const PROVIDERS: readonly Provider[] = ["bedrock", "foundry", "vertex"];
const isProvider = (p: string): p is Provider => (PROVIDERS as readonly string[]).includes(p);

// The volume the suggestion is worked at: a whole number of applications a
// day from 1 to 100, else the default.
export function parseApplicationsADay(text: string | null): number {
  const n = Number(text);
  return text && Number.isInteger(n) && n >= 1 && n <= 100 ? n : DEFAULT_APPLICATIONS_A_DAY;
}

async function pageInput(db: D1Database, userId: string, applicationsADay: number, now: Date): Promise<BudgetsPageInput> {
  const providers = (await connectedProviders(db, userId)).filter(isProvider);
  const cards = await Promise.all(
    providers.map(async (provider) => ({
      provider,
      budget: await readBudget(db, userId, provider),
      spentThisMonth: await monthSpend(db, userId, provider, now),
      suggestion: await suggestBudget(db, await pickedModels(db, userId, provider), applicationsADay),
    })),
  );
  return { cards, applicationsADay };
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

// GET shows the page; POST sets one provider's budget from the typed amount
// or, when none is typed, the accepted suggestion, then shows the page again. Scoped to the
// signed-in user throughout.
export async function handleBudgets(request: Request, db: D1Database, userId: string, now: Date): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    return html(renderBudgetsPage(await pageInput(db, userId, parseApplicationsADay(url.searchParams.get("per_day")), now)));
  }
  // A form posted from another site is refused.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return new Response(null, { status: 403 });
  const form = await request.formData();
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };
  const applicationsADay = parseApplicationsADay(field("per_day"));
  const provider = field("provider");
  const refuse = async (problem: string) =>
    html(renderBudgetsPage({ ...(await pageInput(db, userId, applicationsADay, now)), problem }), 400);
  if (!isProvider(provider) || !(await connectedProviders(db, userId)).includes(provider)) {
    return refuse("That provider is not connected.");
  }
  const typed = field("amount").trim();
  const amount = parseBudget(typed || field("accept"));
  if (amount === undefined) {
    return refuse("Type a budget in dollars, more than $0, for example 30.");
  }
  await setBudget(db, userId, provider, amount, typed ? "typed" : "accepted", now);
  return Response.redirect(`${url.origin}${BUDGETS_PATH}?per_day=${applicationsADay}`, 303);
}
