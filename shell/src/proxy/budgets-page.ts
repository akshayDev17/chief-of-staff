// Models › Setup › Budgets, rendered on the server (design T02 / T12): one
// card per provider the user has connected, each with its monthly budget.
//
// Each card suggests a monthly value with its basis, marked "estimate" with
// its "checked on" date (the date the prices it uses were read), worked out
// from the list price of the dearest model the user's tasks use there (or,
// before any task has one, the dearest model the user picked there) and the
// design's tokens per application (budgets.ts) at the volume the user plans.
// The user accepts it with one tap or types their own; until then the card
// says the provider's models cannot be called. Once it is set, the card shows
// the month's spend against it as the budget bar (budget-bar.ts). The Usage
// page, not built yet, is named but not linked.

import { CONTROLS_CSS, esc, nbDate, PAGE_CSS } from "../prices/page";
import { isProvider, type Provider } from "../prices/types";
import { rerunBudgetWait } from "../providers/check";
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
import { BAR_CSS, BAR_JS, readKeyFigure, renderBudgetBar, type KeyFigure } from "./budget-bar";
import { connectedProviders, readConnection } from "./connections";
import type { SecretStore } from "../providers/secrets";
import type { ConnectionFields, PluginRegistry } from "./plugin";
import { monthSpend } from "./ledger";
import { PROVIDER_NAMES } from "./proxy";
import { BUDGETS_PATH, PROVIDERS_PATH, TASK_MODELS_PATH } from "../paths";

export interface ProviderBudgetCard {
  provider: Provider;
  budget?: Budget;
  spentThisMonth: number;
  suggestion?: Suggestion;
  // OpenRouter's own figure for the key, read once the budget is set.
  key?: KeyFigure;
  connection?: ConnectionFields;
}

export interface BudgetsPageInput {
  cards: ProviderBudgetCard[];
  applicationsADay: number;
  // A plain message after a refused form, shown above the cards.
  problem?: string;
}

const dollars = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

function card(c: ProviderBudgetCard, applicationsADay: number): string {
  const name = PROVIDER_NAMES[c.provider];
  const s = c.suggestion;
  const suggestion = s
    ? `<p class="small muted">Suggested · <span class="pill warn">estimate</span> · checked on ${nbDate(s.checkedOn)}</p>
<p class="big">about ${dollars(s.monthlyUsd)} a month</p>
<p class="small">Basis: ${applicationsADay} application${applicationsADay === 1 ? "" : "s"} a day, if this provider carried every task, at ${esc(s.model)}'s list prices from the app's price table and the design's tokens per application. Replaced by the figures measured in practice mode.</p>`
    : `<p class="small muted">No suggestion yet: it is worked out from the list price of a model you pick at this provider (<a href="${PROVIDERS_PATH}">choose one on its Connect screen</a>).</p>`;
  const set = c.budget
    ? `<p class="ok-line">Budget set: ${dollars(c.budget.monthlyUsd)} a month</p>`
    : "";
  const unset = c.budget ? "" : `<p class="small muted">Until it is set, this provider's models cannot be called.</p>`;
  const bar =
    c.budget && c.key
      ? renderBudgetBar({ budgetUsd: c.budget.monthlyUsd, ledgerUsd: c.spentThisMonth, key: c.key, budgetHref: `#amount-${c.provider}`, connection: c.connection })
      : "";
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
${bar}
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
<style>${PAGE_CSS}${CONTROLS_CSS}${CSS}${BAR_CSS}</style>
</head>
<body>
<main class="screen">
<h1>Models</h1>
<div class="subtabs"><span class="on">Setup</span><span aria-disabled="true">Usage</span></div>
<p class="small" style="margin:-4px 0 10px"><a href="${PROVIDERS_PATH}">Providers and models</a> · <strong>Budgets</strong> · <a href="${TASK_MODELS_PATH}">Model for each task</a></p>
<h2>Budgets, one per provider</h2>
<p>Each provider bills you for the month, so each gets its own monthly budget, counted from the 1st. When one is spent, calls to that provider stop until the 1st, a task's fallback model there too. The key OpenRouter issued the app also has its own credit limit, set on OpenRouter's page when you connected; OpenRouter stops the key there.</p>
${input.problem ? `<div class="banner warn" role="alert">${esc(input.problem)}</div>` : ""}
<form class="row" method="get" action="${BUDGETS_PATH}" style="margin:8px 0">
<label class="small" for="per-day">Applications a day you plan</label>
<input class="f" id="per-day" name="per_day" inputmode="numeric" style="max-width:5em" value="${input.applicationsADay}">
<button type="submit" class="btn small secondary">Work out</button>
</form>
${cards}
<p class="small muted">A budget is any amount more than $0 a month.</p>
</main>
<script>${BAR_JS}
</script>
</body>
</html>`;
}

const CSS = `
.grid { display: grid; gap: 12px; grid-template-columns: 1fr; }
@media (min-width: 760px) { .grid.c2 { grid-template-columns: 1fr 1fr; } }
.grid > .card { margin-top: 0; }
.card h3 { margin: 10px 0 6px; }
.big { font-size: 1.6rem; font-weight: 500; line-height: 1.1; margin: 4px 0; }
`;


// The volume the suggestion is worked at: a whole number of applications a
// day from 1 to 100, else the default.
export function parseApplicationsADay(text: string | null): number {
  const n = Number(text);
  return text && Number.isInteger(n) && n >= 1 && n <= 100 ? n : DEFAULT_APPLICATIONS_A_DAY;
}

export interface KeyReader {
  secrets: SecretStore;
  fetcher?: typeof fetch;
}

async function pageInput(db: D1Database, userId: string, applicationsADay: number, now: Date, reader: KeyReader): Promise<BudgetsPageInput> {
  const providers = (await connectedProviders(db, userId)).filter(isProvider);
  const cards = await Promise.all(
    providers.map(async (provider): Promise<ProviderBudgetCard> => {
      const budget = await readBudget(db, userId, provider);
      const connection = await readConnection(db, userId, provider);
      return {
        provider,
        budget,
        spentThisMonth: await monthSpend(db, userId, provider, now),
        suggestion: await suggestBudget(db, await pickedModels(db, userId, provider), applicationsADay),
        ...(budget ? { key: await readKeyFigure(reader.secrets, userId, now, reader.fetcher) } : {}),
        connection,
      };
    }),
  );
  return { cards, applicationsADay };
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

// GET shows the page; POST sets one provider's budget from the typed amount
// or, when none is typed, the accepted suggestion, re-runs that provider's
// test call if it was waiting for a spent budget, then shows the page again.
// Scoped to the signed-in user throughout.
export async function handleBudgets(
  request: Request,
  db: D1Database,
  plugins: PluginRegistry,
  userId: string,
  now: Date,
  reader: KeyReader,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    return html(renderBudgetsPage(await pageInput(db, userId, parseApplicationsADay(url.searchParams.get("per_day")), now, reader)));
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
    html(renderBudgetsPage({ ...(await pageInput(db, userId, applicationsADay, now, reader)), problem }), 400);
  if (!isProvider(provider) || !(await connectedProviders(db, userId)).includes(provider)) {
    return refuse("That provider is not connected.");
  }
  const typed = field("amount").trim();
  const amount = parseBudget(typed || field("accept"));
  if (amount === undefined) {
    return refuse("Type a budget in dollars, more than $0, for example 30.");
  }
  await setBudget(db, userId, provider, amount, typed ? "typed" : "accepted", now);
  await rerunBudgetWait(db, plugins, userId, provider, now);
  return Response.redirect(`${url.origin}${BUDGETS_PATH}?per_day=${applicationsADay}`, 303);
}
