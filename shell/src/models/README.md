# Choosing a model (T17, design-v3 1.5)

There is no separate Add a model page: the model list is on the provider's
Connect screen, below a passed Connect (Models › Setup › Providers,
`src/providers/models-panel.ts`; logic in `add.ts`), and the old path
`/chief-of-staff/models/setup/add` redirects there.

**The list** is every model OpenRouter lists (the owner, 2026-11-27: "i would
like to list all models and then choose"), from its public models API, read
with the price table (`src/prices/README.md`). The public list needs no key
and is the same for every account. The user's own account can allow fewer:
OpenRouter's `/api/v1/models/user`, read with the user's key after Connect and
on Refresh model list (`account-list.ts`), "filtered by user provider
preferences, privacy settings, and guardrails" (a guardrail can hold a model
allowlist). A model the account leaves out stays in the list, marked "not
offered for your account", and cannot be chosen.

The dropdown is a custom listbox (a native `<select>` cannot colour its
entries; the ARIA select-only combobox pattern, with keyboard, focus and a
plain `<select>` for a browser without scripts). Each entry shows, with
nothing to type: the model's ID and name; its input and output list price per
million tokens, "OpenRouter models API, read <date>", and a note when the last
refresh failed and the last good price is kept; its strength (Smallest,
Middle, Strongest) as a coloured label naming it in words; and notes: added,
"no tool use (OpenRouter lists no tool support for it)", "OpenRouter retires
it on <date>", "priced higher from <n> prompt tokens". An entry cannot be
chosen, and says why, when the app cannot call it (a router, a `~` alias, a
model with no text), the account leaves it out, or it has no price yet.

**Choosing** a model runs its own test call once, right there, through the
proxy (`sendTestCall`, task `test_call`), capped at 16 reply tokens. The model
is added (a `user_models` row, with the passed call's reply, tokens and cost)
only when the call passes and the reply names that model (`namesPickedModel`:
the same ID, or with a date stamp or a variant such as `:batch`, never a
longer ID such as `gpt-6-luna-pro` for `gpt-6-luna`). Otherwise the plain
reason shows under the list with OpenRouter's own reply.

**Test all models** (`test-all.ts`) tests every model the user can choose, to
show which work for their account right now (the owner, 2026-11-27:
"post-connection testing just to let a COS user see that w.r.t. that provider
what all models work and what arent at the moment"). It first shows how many
models and the estimated total (each model's price for at most 40 input and
16 output tokens, plus any fee per call), and runs only on confirm. The
every-minute cron then claims the queued tests and runs them, 50 a minute at
most across every user, 5 at once, each the model's own test call (task
`test_all_models`); a tick claims each test before calling, so overlapping
ticks never test a model twice, and a claim older than 10 minutes is taken
again. A 200 with no text (a reasoning model that spent its tokens thinking)
counts as working. One run at a time per user (a unique index holds it when
two starts race), a new one at most every 10 minutes. The results (stored per
user, `model_tests`) show each model as "works now" or "doesn't work now" with
the plain reason and OpenRouter's reply, filterable, with the real total: the
sum of the run's ledger rows, OpenRouter's reported cost. A run adds nothing
to the user's models. Each model that works has a one-tap **Add**
(`addTestedModel`), which adds it with that run's passed test call and makes
no new call; it is refused for a model that did not pass in the user's latest
run.

A free model ($0 in and out, such as OpenRouter's `:free` ones) reads "free:
rate-limited, and the provider may log prompts" in the model list and in the
picker.

`readUserModels(db, userId)` returns the user's added models at every
provider a plug-in serves (rows left from Bedrock, Vertex AI or Foundry are
ignored): what the per-task picker offers. Every query is scoped to the
signed-in user.

# Model for each task (T18, design-v3 1.5 and decision 6)

Models › Setup › Model for each task (`GET /chief-of-staff/models/setup/tasks`,
`picker-page.ts`; logic in `tasks.ts`). `TASKS` is the list the app routes
model calls by, each with the owner's tier (2026-11-24): Smallest for
matching, extraction and LinkedIn invitations and messages; Middle for
scoring, filling and checking forms, cover letters and free-text answers. No
task defaults to Strongest.

For each task the user chooses the provider and the model (the owner,
2026-11-27: "for each kind of task : choose the provider and the model"),
for the main model and the fallback, from their own passed models only. The
provider list has one entry today, OpenRouter; another provider's passed
models join the same lists (`task_routes` names each by provider and model).

- one passed model: every task uses it, with nothing to tap, unless it is
  free;
- more: each task is proposed the cheapest passed model at its tier and, as
  its fallback, the next cheapest at that tier, another model (on OpenRouter
  today, so another OpenRouter model), never the main one; where the user has
  none at the task's tier, the other non-Strongest tier, and the page says
  so. **Accept all with one tap** saves every proposal (`set_how`
  `accepted`); an accepted task follows its proposal until the next tap, and
  a task the user changed is never overwritten;
- a free model is never proposed, as main or fallback: a task uses it only
  once the user chooses it with Change;
- any task can be changed to any passed model, the Strongest included, with
  a fallback that is another model, or none.

`callTask` sends a task's call through `callModel` with its main model and
fallback: OpenRouter refusing or failing the main call (429, 408, 5xx, no
reply) is answered once by the fallback, named in its ledger row. A spent
budget or a missing key stops both, since they share the one provider.
Until a proposal is accepted or a model chosen, a task with several models
has none, and `callTask` refuses it (`no_model`). Every query is scoped to the
signed-in user.
