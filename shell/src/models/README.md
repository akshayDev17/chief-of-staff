# The model list, and the Ready models (T17, design-v3 1.5)

There is no separate Add a model page, and no Add at all (the owner,
2026-11-27: "quite franky remove the add feature altogether"). The model
table is on the provider's Connect screen, shown once connected (Models ›
Setup › Providers, `src/providers/models-table.ts`; logic in `ready.ts`,
`test-model.ts`, `latest-tests.ts`, `price-caps.ts`), and the old path
`/chief-of-staff/models/setup/add` redirects there.

**Ready models** (`ready.ts` `rowState`, the one rule) are the models a
user's tasks can use, with no test call (the owner, 2026-11-28: "why would i
as a user wanna waste my money on testing models i dont wish to test"). A
model is Ready when:

- the model list has it, which means OpenRouter lists tool use among its
  `supported_parameters` (a model without tool use never reaches the list,
  `test-model.ts` `listOffer`, and "About this list" counts the ones left
  out);
- nothing blocks it: the account's own list includes it, a router has the
  user's price cap, it has a price, and the app can call it; and
- it is free, or the account has credit left.

No call decides it, a Test's or a task's, and its label is Ready, never
Works: no call was made. Every other row is in exactly one other state:
**Needs credit** (a paid model on an account with no credit left, with Add
credits, OpenRouter's credits page), or **Needs a step** (the account's
settings leave it out, with a link to them and Check again; a router with
Set price cap; no price yet; the app can't call it). Ready + Needs credit +
Needs a step is the list's own
count, the strip's total and the count line's, from that one rule
(`models-table.ts` `stripCounts`).

**The credit figure** is the account line's: OpenRouter's `GET /api/v1/key`,
read live with the user's key, server side, on every visit to Providers and
to Model for each task (`ready.ts` `readAccountLive`). The account has
credit left when it has bought credit (`is_free_tier` false) and, where the
key has its own limit, the limit is not used up. The app cannot read the
balance itself (`GET /api/v1/credits` needs a management key), so an account
whose bought credit ran out reads as having credit: its paid model's call is
refused with no credit and the task falls to its fallback; that refusal
marks nothing, so the credit figure alone says Needs credit or Ready. The figure
is kept on the connection (`has_credit`, migration 0014), so every reader
takes the same one; a Connect with another key empties it, and the first
reader that needs it reads it live again. Because it is read on every visit,
credit added on OpenRouter makes the paid models Ready on the next visit,
with no click.

**Failed when used.** A task's own call (`tasks.ts` `callTask`) that the
provider refuses goes to the task's fallback (`src/proxy/README.md`), and
marks the main model's row "Failed when used · <its plain reason> · Try
again" (`ready.ts` `recordUse`); a fallback that fails too is marked the
same way. A refusal that says nothing about the model (busy, no reply, the
key removed, no credit) marks nothing. A later call of the model that
answers, a task's or a Test's, takes the mark back. Try again, in place of
Test on that row, is the same one test call. The mark is only a label: the
model stays Ready and in the task dropdowns, and a task that has it saved
tries it first on each call, so it answers again as soon as the provider
takes it back, with no click. A failed Test marks its row "Failed when
tested" the same way, and changes nothing else. Each
model's latest call is one row of `model_latest_tests`
(`latest-tests.ts`); one made on an earlier key (`onEarlierKey`, before the
connection's `connected_at`) marks nothing, since that key's account may
have had other settings. Connect makes a new key and records when; a Connect
that brings back the very same key (the same `key_hash`) keeps the earlier
`connected_at`. Migration 0013 carried the tests made before it over. The
old `user_models`, `model_test_runs` and `model_tests` tables are no longer
read or written.

**The list** is every model OpenRouter lists with tool use (the owner,
2026-11-27: "i would like to list all models and then choose"; 2026-11-28:
anything the app can identify as never choosable is not shown), from its
public models API, read with the price table (`src/prices/README.md`). These
are left out, each kind counted under "About this list": `~` aliases,
`:batch` variants, routers no price cap can bound, models that give audio,
images or video, give no text, or list no price, and models that list no
tool use. The public list needs no key and is the same for every account.
The user's own account can allow fewer: OpenRouter's `/api/v1/models/user`,
read with the user's key after Connect, on Refresh model list and on Check
again (`account-list.ts`), "filtered by user provider preferences, privacy
settings, and guardrails". A model the account leaves out stays in the table
in Needs a step, with one action on its row: a link to the account's
settings on OpenRouter, then Check again.

**One table**, nothing to type but the search. Search matches any part of a
model's name, maker or ID. The Maker filter has its own find box and chips.
The Ready / Needs credit / Needs a step strip filters the
table, over a bar of the true ratios; it counts the rows search, the Maker
filter and a strength show (each row's `rowState`), its end label then
reading "N shown". An address with `strength=<Smallest|Middle|Strongest>`
(and `show=<ready|credit|step>`) opens the table showing that
strength's models (in that state), as Model for each task links a strength
with no Ready model; the count line names it, with Show all. None of these
sends a request. Each row shows the model's name and maker, its input and
output list price per million tokens (each side's range where its standard
tool hosts' prices differ), its strength (Smallest, Middle, Strongest) from
its typical price, input and output blended 10:1 at its middle host, against
the month's two lines (`prices/tiers.ts`; the sentence under the table states
them), a Free label on a free model and "Other fees"
on one at $0 a token that is not free, Needs credit or Failed when used
where it is so, and **Test**. Test is optional: it runs the model's own test
call once through the proxy (`sendTestCall`, task `test_call`), capped at 16
reply tokens, and the result opens under the row. The call passes when it
answers and its reply names that model (`namesPickedModel`: the same ID, or
with a date stamp or a variant such as `:batch`, never a longer ID such as
`<model>-pro` for `<model>`). A router's reply names the model it picked,
which is the point. A failure shows its plain reason, with OpenRouter's own
reply collapsed, and names the tasks whose saved model it is, with the
fallback each falls to. Only the model's own verdict is recorded
(`test-model.ts` `isVerdict`): a refusal that says nothing about the model
(the provider not connected, the month's budget spent, no credential, no
credit, the provider busy, or a test that could not run) shows in the result
only.

**A router's price cap** (`price-caps.ts`). OpenRouter prices a router such as
`openrouter/auto` by the model it picks for each call (`pricing.prompt`
"-1"), so it has no price of its own. Only a router OpenRouter publishes
itself that takes request parameters is listed; its row has a labelled **Set
price cap**. The cap, in USD per million input and output tokens, is the
router's price for the table, for its tier and for the budget stop. Every
call to the router carries OpenRouter's `provider.max_price` at the cap, with
the fees per request, image and audio unit at "0". It also carries the
auto-router plugin's `excluded_models`: every listed model whose pricing has
a per-search or per-request fee, since `max_price` has no field for search
fees. OpenRouter's answer that no model fits the account's settings or the
cap has its own reason and actions (`src/providers/README.md`, the 404 row);
any other refusal under the cap shows OpenRouter's own words.

**Test all models is gone** (the owner, 2026-11-28: "what if i dont wish to
test all after having credits"), with Retest failed and the every-minute
cron that ran its queue. Its calls stay in this month's ledger under the
task `test_all_models`, named "Test all models" on Models › Usage.

A free model (`src/prices/openrouter.ts` `isTrulyFreeTextModel`: it gives
only text and every price OpenRouter lists for it is 0, see
`src/providers/README.md`) carries a Free label. It reads "free:
rate-limited, and the provider may log prompts" in the picker, and the plug-in's
terms for free models are under "About this list" (`freeModelTerms`). A $0
account can do the whole flow with no call at all. Connect makes no call.
Its free models the account's list includes are Ready. Its paid models read
Needs credit, with Add credits.

# Model for each task (T18, design-v3 1.5 and decision 6)

Models › Setup › Model for each task (`GET /chief-of-staff/models/setup/tasks`,
`picker-page.ts`; logic in `tasks.ts`). `TASKS` is the list the app routes
model calls by, each with the owner's tier (2026-11-24): Smallest for
matching, extraction and LinkedIn invitations and messages; Middle for
scoring, filling and checking forms, cover letters and free-text answers. No
task defaults to Strongest.

Each task has one dropdown for its main model and one for its fallback, and
each lists every Ready model of the task's strength (`ready.ts`, no test
needed; the owner, 2026-11-27: "when suggested strenght == Smallest --> the
dropdown next to it should only contain all passing run models tagged with
the smallest chip"; 2026-11-28: "why would i as a user wanna waste my time
and money searching for models i want to use followed by hitting test? just
so that they get added in the "Models for each task"?"): a Ready model whose
strength chip (`prices/tiers.ts` `strengthChip`, the chip
its Providers row shows: its tier, or "Other fees" for a model at $0 a token
that is not free) is the task's tier (`tasks.ts` `offeredFor`), the cheapest
first by the typical price its strength comes from. Each reads as its row
does: name, ID, and price per million input and output tokens, or Free. The models are grouped under their provider, so
choosing one chooses the provider and the model (the owner, 2026-11-27: "for
each kind of task : choose the provider and the model"); the provider list
has one entry today, OpenRouter, and another provider's Ready models join
the same lists (`task_routes` names each by provider and model). A list of
more than six has a search box at its top (any part of the name, ID or
provider).

Choosing sends nothing (`picker-script.ts`): the changed rows are counted in
a bar with Undo and Save. Save sends them in one request (`POST
/chief-of-staff/models/setup/tasks/change`, fields `task`, `main.<task>`,
`fallback.<task>`), saved all or none (`changeTasks`), and the page's
`<main>` comes back in place, the address and the scroll kept. Without
scripts the dropdowns are plain selects, each row has its own Save, and
every form posts and redirects back with what it said in the address. One
solid blue button at a time: Save while a row is changed, else **Accept all
with one tap**, else the free tap, else the first row's fix for a task with
no model; this last screen has no Next while the checklist's next item is
not built. Accept all and the free tap, sent in place, carry the rows
changed and not saved: those are saved as chosen in the same request, all
or none, and the tap leaves them as chosen. Ask Admin for help saves
nothing: in place, its answer shows in the banner only, and the changed
rows stay as they are, still to save.

- a task uses only its saved choice. A task with no saved choice has no
  model; migration 0013 saved, as an accepted choice with no fallback, the one
  model each user's tasks used before (the user's only added model, unless
  free);
- a saved choice is always shown, even once its model is not in the list.
  One of another strength saved before this rule keeps running and its row
  says so; Save keeps a model a role already names, so a change to one role
  never forces the other, but a model of another strength is never newly
  chosen (`wrong_strength`);
- a saved choice holds while the provider offers its main model to the user
  (the model list has it and nothing blocks it). One that needs credit
  keeps its place, marked so with Add credits:
  each call tries it first and falls to the fallback when it fails, so it
  answers again once credit is added or the provider takes it back, with no
  click. Once the provider no longer offers it, no proposal or one tap
  replaces the choice by itself. The row marks it "Not offered" and says why
  (`tasks.ts` `NotUsable`): it is no longer on OpenRouter's list (Choose
  another), the account's settings leave it out (a link to them), it needs a
  price cap (Set its price cap), it lists no tool use (Choose another), else
  that it is no longer offered (Choose another). Its calls go to its saved
  fallback while that is offered, and the row says it runs on its fallback;
  with no fallback the task has no model and its calls are refused with a
  plain reason, never sent to a model the user did not choose for the task
  (`readTaskRoutes` `stopped`, the one rule `routeTask` calls by). A saved
  fallback no longer offered is shown the same way (`fallbackGone`), while
  the main model runs alone;
- a strength with no Ready model says so in each of its rows: with Add
  credits where its paid models need credit, else a link to Providers and
  models showing that strength's models (`?strength=<tier>#test`, read by the
  Providers script), or Connect OpenRouter (`picker-data.ts` `readToReady`,
  counting the rows the strip counts as Needs credit, by `rowState`);
- each task is proposed the cheapest Ready model of its strength and, as
  its fallback, the next cheapest of that strength, another model (on
  OpenRouter today, so another OpenRouter model), never the main one and
  never one of another strength. **Accept all with one tap**, beside the line
  that counts the tasks with a model, saves every proposal (`set_how`
  `accepted`); an accepted task whose proposal has since changed keeps its
  models until the next tap and its row names the new proposal, and a task
  the user changed is never overwritten;
- a router (priced per call by the model it picks, its price the user's
  cap, a ceiling and not what a call costs) is never proposed, as main or
  fallback, at any cap, so Accept all never saves one; it stays in its
  strength's list to choose;
- a free model is never proposed, as main or fallback: a task uses it only
  once the user chooses it in its list or with **Use my free models for N
  tasks** (`useFreeModels`), the one tap the page offers, and explains, for
  the tasks with no model and no proposal (a $0 account's Ready models are
  all free). It picks by the proposal's own rule among the free models of
  each task's strength, so a free model, Smallest by its $0 price, takes the
  Smallest tasks only, and saves them as the user's choice (`set_how`
  `changed`).

`callTask` sends a task's call through `callModel` with its main model and
fallback: OpenRouter refusing or failing the main call (any refusal of the
call, or no reply) is answered once by the fallback, named in its ledger
row, and the main model's row on Providers reads Failed when used (`ready.ts`
`recordUse`). A spent budget or a missing key stops both, since they share
the one provider. Until a proposal is accepted or a model chosen, a task has
none, and `callTask` refuses it (`no_model`), saying to choose a model for it
on Model for each task; so does a task whose saved main model and fallback
the provider both no longer offers, saying to choose another. Every query is
scoped to the signed-in user.

## Try it

Each row with a saved model has **Try it** (`try-task.ts` `tryTask`,
`POST /chief-of-staff/models/setup/tasks/try`, field `task`). It proves the
pipeline every task's own calls will use, never a task's quality (the
owner, 2026-11-28: "the pipeline that each task will eventually have to
subscribe to and use is the one being tested"):

- it reads the task's saved main model and fallback, and never writes them;
  while the row has changes not saved it waits ("Save first"), since it
  calls the saved models only;
- the proxy checks the month's budget before each call: none set, or
  spent, is refused with no request to the model;
- it sends the task's one short fixed sample prompt (`Task.sample` in
  `tasks.ts`: made up, with no job data and nothing about the user) as the
  provider's own request (`connect.promptRequest`), the reply capped at
  `TRY_MAX_TOKENS`, through `callTask`, so the proxy routes it to the saved
  model only, carries a router's price cap, retries a failed main call once
  on the fallback (the main's row then reads Failed when used), and writes
  one ledger row per call sent; when the main fails and the fallback is
  then refused, it says both, with the fallback's fix;
- under the row, in place and with no reload, it shows the reply (a long
  one collapsed after its start), the model that answered and whether it
  was the main model or the fallback (a router's, with the model it picked),
  the input, cached and output tokens, the cost, the call's time and the
  month's spend after it, the same ledger figure as the budget bar and
  Models › Usage. The tokens and cost are OpenRouter's own, from its reply
  (`usage.prompt_tokens`, `prompt_tokens_details.cached_tokens`,
  `completion_tokens` and `usage.cost`; `src/providers/openrouter.ts`
  `usageFromReply`); one with no reported cost is marked "est.". The call's
  OpenRouter ID, to find it on OpenRouter's Activity page, is under "What
  this proves". Without scripts it posts, and the page comes back with the
  result under the row.

# Models › Usage (design-v3 10.1)

`/chief-of-staff/models/usage` (`usage-page.ts`, figures in `usage.ts`) shows
the month's OpenRouter spend, counted from 00:00 UTC on the 1st:

- the month's figure: the app's own count, labelled as the figure that stops
  calls at the budget, and against the budget once one is set. With a budget
  the card also shows the budget bar, the same bar as Models › Setup ›
  Budgets (`src/proxy/budget-bar.ts`), headed by the larger of the two counts
  with its source named ("by OpenRouter's figure" or "by the app's count").
  OpenRouter's own figure for the current key is read live, server side, on
  every visit, budget or not, from the same key and endpoint as Providers'
  account line;
- per model and per task: calls (and how many OpenRouter refused), input and
  output tokens, and cost. All three come from one read of the ledger
  (`model_calls`), so each table's foot is the bar's own count, the one the
  proxy stops calls at.

Each model is named as OpenRouter's live list names it, its ID beside it; a
model no longer in the list shows its ID only. "free" marks a model the list
marks free. A cost is OpenRouter's own, from its reply; one costed at list
price, where the reply reported none, is marked estimated, and so is a row
written before the ledger recorded how it was costed. The test calls appear
as the tasks "Model tests" and "Test all models".

Both tables list the dearest first, ties by name, in a fixed order with no
sort control. Per model scrolls inside its own box, about ten rows tall (fewer
on a phone), with its column header and its "This month" foot pinned; over
ten rows a search sits above it (any part of the name, maker or ID, a live
count, Clear when nothing matches), with beside it the same Maker filter as
Providers (`maker-filter.ts`), which names a maker as Providers does and
narrows the rows together with the search. While either narrows the rows, the
foot, still the month's totals, reads "All models this month". Both run in
the page only, with no request and the address unchanged; without scripts
they stay hidden and the box holds the whole list. Per task, a row per task,
stays a plain table.

When OpenRouter's figure for the current key and the app's count differ, one
line under the figures says why, with the detail collapsed: each Connect makes
a new key and records when (`connected_at`), so this month's calls from before
then were made with an earlier key and are not in its figure. When those do
not account for the difference, the line says only that the two differ. When
OpenRouter's figure cannot be read while OpenRouter is connected and no
budget is set, the line says so, and why, instead; with a budget set, the
bar's own source line says it.

With nothing to show yet, the page highlights one next action, the first
missing: Connect OpenRouter, then Set a budget, then Test a model. After a
Disconnect the month's figures stay, and the page says they are from before
it, with Connect OpenRouter as its next action.
