# Testing models, and the usable ones (T17, design-v3 1.5)

There is no separate Add a model page, and no Add at all (the owner,
2026-11-27: "quite franky remove the add feature altogether"). The model
table is on the provider's Connect screen, shown once connected (Models ›
Setup › Providers, `src/providers/models-table.ts`; logic in
`test-model.ts`, `usable.ts`, `test-all.ts`, `price-caps.ts`), and the old
path `/chief-of-staff/models/setup/add` redirects there.

**Usable models** (`usable.ts` `readUsableModels`) are the models a user's
tasks can use: every model whose latest test passed, whichever way it ran (Test
on its row, Test all models, Retest failed), that the provider's current list
still offers the user. That means the list names it and the app can call it,
a router has the user's price cap, and the account's own list, where read,
includes it. A later failed test takes the model out, and a later pass puts
it back. Only the model's own verdict counts as its latest test: a refusal
that says nothing about the model (`test-model.ts` `isVerdict`: the
provider not connected, the month's budget spent, no credential, no credit,
the provider busy, or a test that could not run) changes nothing about
whether it is usable. Its row still shows that outcome: Test all's in the
run, a single Test's in the page's view. The strip's Works / Doesn't work
counts and filters go by the verdict. Each model's latest verdict is one row of
`model_latest_tests`. A Test all models run that is still testing a model
does not change it, so tasks keep their models while a run goes on.
Migration 0013 carried the tests made before it over: each model's newest
of its latest run verdict and the passed test it was added with; a run's
refusal that says nothing about the model is not carried. The old
`user_models` table is no longer read or written.

**The list** is every model OpenRouter lists that a test can pass (the owner,
2026-11-27: "i would like to list all models and then choose"; 2026-11-28:
anything the app can identify as never choosable is not shown), from its
public models API, read with the price table (`src/prices/README.md`). These
are left out, each kind counted under "About this list": `~` aliases,
`:batch` variants, routers no price cap can bound, and models that give
audio, images or video, give no text, or list no price. The public list needs
no key and is the same for every account. The user's own account can allow
fewer: OpenRouter's `/api/v1/models/user`, read with the user's key after
Connect, on Refresh model list and on Check again (`account-list.ts`),
"filtered by user provider preferences, privacy settings, and guardrails". A
model the account leaves out stays in the table with one action on its row:
a link to the account's settings on OpenRouter, then Check again.

**One table**, nothing to type but the search. Search matches any part of a
model's name, maker or ID. The Maker filter has its own find box and chips.
The Works / Doesn't work / Not tested yet strip filters the table, over a bar
of the true ratios. An address with `strength=<Smallest|Middle|Strongest>`
(and `show=pending`) opens the table showing that strength's models (not
tested yet), as Model for each task links a strength with no usable model;
the count line names it, with Show all. None of these sends a request. Each row shows the model's
name and maker, its input and output list price per million tokens, its
strength from the input price (Smallest, Middle, Strongest), a Free label on a
free model and "Other fees" on one at $0 a token that is not free, Works or
its failure ("Doesn't work", "Needs credit", "Busy"), and **Test**. Test runs
the model's own test call once through the proxy (`sendTestCall`, task
`test_call`), capped at 16 reply tokens, and the result opens under the row.
The call passes when it answers and its reply names that model
(`namesPickedModel`: the same ID, or with a date stamp or a variant such as
`:batch`, never a longer ID such as `<model>-pro` for `<model>`). A router's
reply names the model it picked, which is the point. A failure shows its
plain reason, with OpenRouter's own reply collapsed, and names the tasks
whose saved model it was.

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
fees. A refusal under the cap (no model fits, say) shows OpenRouter's own
words.

**Test all models** (`test-all.ts`) tests every model the user can test, to
show which work for their account right now (the owner, 2026-11-27:
"post-connection testing just to let a COS user see that w.r.t. that provider
what all models work and what arent at the moment"). It first shows how many
models and the estimated total, and runs only on confirm. The every-minute
cron then claims the queued tests and runs them, at most 50 a minute across
every user, 5 at once, each the model's own test call (task
`test_all_models`). A tick claims each test before calling, so overlapping
ticks never test a model twice, and a claim older than 10 minutes is taken
again. A 200 with no text (a reasoning model that spent its tokens thinking)
counts as working. Each result is recorded in the run, and each verdict
becomes the model's latest test. One run at a
time per user (a unique index holds it when two starts race), and a new one
at most every 10 minutes. **Retest failed (N)** reruns, in the same run, the
run's failures, verdicts or not, that can still be tested and have not passed since. A run made
on an older model list (`CATALOG_VERSION`) offers no Retest failed. The real
total is the sum of the run's ledger rows: OpenRouter's reported cost.

**The estimate** is each model's last measured test cost where the user has
one: its latest answered test call's ledger row, which is the same request
and so the same price. Otherwise it is the model's list price for at most 40
input and 16 output tokens, plus any fee per call, plus one search for a
model that searches the web on its own. The run of 2026-11-27 cost $0.35
against a $0.07 token-only estimate, for two reasons. Per-search fees were
$0.24 of it (Perplexity's Sonar Deep Research alone was $0.23). And some
models billed 1,300 to 2,100 input tokens for the one-line prompt
(`test/test-all-estimate.test.ts`, on that run's reported costs).

A free model (`src/prices/openrouter.ts` `isTrulyFreeTextModel`: it gives
only text and every price OpenRouter lists for it is 0, see
`src/providers/README.md`) carries a Free label. It reads "free:
rate-limited, and the provider may log prompts" in the picker, and the plug-in's
terms for free models are under "About this list" (`freeModelTerms`). A $0
account can do the whole flow. Connect makes no call. A free model passes its
test. Test all models shows its paid models as needing credit on OpenRouter.
Its free models that pass are usable for tasks.

# Model for each task (T18, design-v3 1.5 and decision 6)

Models › Setup › Model for each task (`GET /chief-of-staff/models/setup/tasks`,
`picker-page.ts`; logic in `tasks.ts`). `TASKS` is the list the app routes
model calls by, each with the owner's tier (2026-11-24): Smallest for
matching, extraction and LinkedIn invitations and messages; Middle for
scoring, filling and checking forms, cover letters and free-text answers. No
task defaults to Strongest.

Each task has one dropdown for its main model and one for its fallback, and
each lists only the usable models of the task's strength (the owner,
2026-11-27: "when suggested strenght == Smallest --> the dropdown next to it
should only contain all passing run models tagged with the smallest chip"):
a usable model whose strength chip (`prices/tiers.ts` `strengthChip`, the chip
its Providers row shows: its tier, or "Other fees" for a model at $0 a token
that is not free) is the task's tier (`tasks.ts` `offeredFor`), the cheapest
first. Each reads as its row does: name, ID, and price per million input and
output tokens, or Free. The models are grouped under their provider, so
choosing one chooses the provider and the model (the owner, 2026-11-27: "for
each kind of task : choose the provider and the model"); the provider list
has one entry today, OpenRouter, and another provider's usable models join
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
- a saved choice holds while its main model is usable. Once that model is not
  usable (a later test of it failed, or the provider dropped it), no proposal
  or one tap replaces the choice by itself. The row marks it "Not usable" and
  says why, by the same checks as `readUsableModels` (`readNotUsable`): it
  failed its last test (Test it again, on its Providers row), it is no longer
  on OpenRouter's list (Choose another), the account's settings leave it out
  (a link to them), or it needs a price cap (Set its price cap), else that it
  is no longer usable (Choose another). Its calls go to its saved fallback
  while that is usable, and the row says it runs on its fallback; with no
  usable fallback the task has no model and its calls are refused with a
  plain reason, never sent to a model the user did not choose for the task
  (`readTaskRoutes` `stopped`, the one rule `routeTask` calls by and the
  Providers page's note under a failed result follows). A saved fallback no
  longer usable is shown the same way (`fallbackGone`), while the main model
  runs alone;
- a strength with no usable model says so in each of its rows, with a link to
  Providers and models showing that strength's models not tested yet
  (`?strength=<tier>&show=pending#test`, read by the Providers script), or
  all of them once every one has been tested, or Connect OpenRouter
  (`picker-data.ts` `readToTest`);
- each task is proposed the cheapest usable model of its strength and, as
  its fallback, the next cheapest of that strength, another model (on
  OpenRouter today, so another OpenRouter model), never the main one and
  never one of another strength. **Accept all with one tap**, beside the line
  that counts the tasks with a model, saves every proposal (`set_how`
  `accepted`); an accepted task whose proposal has since changed keeps its
  models until the next tap and its row names the new proposal, and a task
  the user changed is never overwritten;
- a free model is never proposed, as main or fallback: a task uses it only
  once the user chooses it in its list or with **Use my free models for N
  tasks** (`useFreeModels`), the one tap the page offers, and explains, for
  the tasks with no model and no proposal (a $0 account's passed models are
  all free). It picks by the proposal's own rule among the free models of
  each task's strength, so a free model, Smallest by its $0 price, takes the
  Smallest tasks only, and saves them as the user's choice (`set_how`
  `changed`).

`callTask` sends a task's call through `callModel` with its main model and
fallback: OpenRouter refusing or failing the main call (429, 408, 5xx, no
reply) is answered once by the fallback, named in its ledger row. A spent
budget or a missing key stops both, since they share the one provider.
Until a proposal is accepted or a model chosen, a task has none, and
`callTask` refuses it (`no_model`), saying to choose a model for it on Model
for each task; so does a task whose saved main model and fallback are both no
longer usable, saying to test its model again or choose another. Every query is scoped to the
signed-in user.

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
