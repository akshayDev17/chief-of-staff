# Add a model (T17, design-v3 1.5)

Models › Setup › Add a model (`GET /chief-of-staff/models/setup/add`, `page.ts`; logic in
`add.ts`). One tab per connected provider; its table lists every chat model
the current price table sells there at a listed price, of every model family
(the owner, 2026-11-24: "list every chat model each provider sells at a listed price, not just Claude, OpenAI and Gemini"), plus the models the
plug-in knows that have no price yet (`connect.knownModels`, for example
Foundry's Claude models before the maintainers' reading of a listing is
recorded).

Each row shows, with nothing to type:

- the region the app calls the model at (the region the user chose on
  Providers where the model is offered there, else the plug-in's default);
- its input and output list price at that region from the price table
  (`listPrices`, T11), with the source and the date read, and a note when the
  source failed and the last good price is kept;
- its strength (the tier, `lookupTier`), worked out from that price.

Foundry calls a model by the user's deployment name: the row fills it in with
the model's ID from Microsoft's catalog pages (`connect.deploymentName`,
`FOUNDRY_MODEL_IDS`), and a user who named the deployment differently changes
it. Friend screens say "Foundry's name for the model".

**Pick** runs the model's test call by itself through the proxy's one
pipeline (`sendTestCall`), which prices it and writes its ledger row (task
`test_call`). The model is added (a `user_models` row, with the passed test
call's reply, tokens and cost) only when the call passes. It is refused, with
the three lines of design-v3 1.5 and nothing stored, when:

- the model has "no price yet" (no input and output price at its region): no
  call is made, because the budget stop needs a real price, and the proxy
  refuses a direct call to it too;
- the plug-in cannot call it yet (`connect.canCall`): the row says "not
  offered yet" with the plug-in's reason for that model
  (`notCallableReason(model)`). Bedrock needs the model's ID from Bedrock's
  own model list, matched to the price-list name (below), and Foundry its
  catalog ID (`FOUNDRY_MODEL_IDS`); Vertex AI has callers only for Claude
  and Gemini so far;
- the reply names a different model than the one picked
  (`connect.replyModel`, `namesPickedModel`): Messages and Chat Completions
  `model`, Gemini's `modelVersion`; Bedrock's Converse names none. The reply
  may add only a date or version stamp to the picked ID, and never names
  another listed model whose ID extends it (`claude-opus-5-5-20261101` is
  not Claude Opus 5);
- the provider refuses the call: the plug-in's plain reason, so a misspelt
  Foundry deployment shows "That deployment name or model ID doesn't exist
  here." with Foundry's own reply under it.

A model known to make no tool call (`connect.noToolUse`) shows **no tool use**
on its row, with the model the live check was made on ("tested live on Gemma
3 4B (google.gemma-3-4b-it): no tool call"), and wherever the per-task picker
names it. It can still be picked: tasks name no tools yet, so the picker
cannot keep it from a task that sends tools (a TODO for T18 in
`picker-page.ts`). A model the provider no longer
offers (`connect.listed`) is left out, unless the user already added it.

**Bedrock.** The list comes from Bedrock's own model list
(`src/providers/bedrock-catalog.ts`), which the app's own AWS role reads once
a day with the price table (ListFoundationModels and ListInferenceProfiles,
the owner's AWS step) and which is stored with the price snapshot. Each AWS
price-list name is matched to a Bedrock model ID by a rule (the same name or
ID as Bedrock's list gives, ignoring case) or by a reviewed entry in
`src/providers/bedrock-models.json`; `test/bedrock-catalog.test.ts` checks
that file against the owner's saved listing and price list. Only those
matches can be picked: any other name says "not offered yet" and why, and a
model Bedrock marks LEGACY is left out. Each model is called at Global where
Bedrock names a Global profile for it and the price table prices it there,
else in the app's region, at its own ID where it runs on demand or at the
geography profile Bedrock names. Gemma 3, Nemotron and DeepSeek R1 are
marked "no tool use" (the owner's live check, 2026-11-26). A model priced by
prompt length whose threshold the app does not know is not offered, rather
than costed too low. Once the list names a model, its verdict wins for every
model. The built-in IDs (`BEDROCK_MODEL_IDS`: four Claude models and Nova 2.0
Lite, the Connect test call's model) serve only names the list has no entry
for: before the list has been read once, when Bedrock offers only those and
says why for the rest, or a name not priced at this region. The Connect test
call alone always uses the test model's built-in profile IDs, whatever the
list says of it.

**Known shortfall.** The `canCall` refusal above is still narrower than this
screen's rule on two providers: Vertex AI calls no publisher but Anthropic
and Google, and `FOUNDRY_MODEL_IDS` leaves out the models whose catalog ID is
not confirmed. Neither is a rule or a product choice (the owner, on how the
list narrowed: "why can COS only call anthropic models?" and "when did i
ever lay such a stipulation?"); follow-up fixes fill those gaps, and until
then the screen says "not offered yet" rather than promise a model it cannot
call.

`readUserModels(db, userId)` returns the user's added models at every
provider: what the per-task picker (T18) offers. Every query is scoped to the
signed-in user.

## Waiting on T10 (checked live in M2 step 3)

Nothing here has called a real provider. Foundry's Chat Completions caller
(every Foundry model but Claude), Vertex AI's Gemini caller, the model each
vendor's reply names (and whether Foundry's names the model or echoes the
deployment), and Gemini's long-prompt threshold are built from the formats
and checked live in M2 step 3 on the owner's accounts.

# Model for each task (T18, design-v3 1.5 and decision 6)

Models › Setup › Model for each task (`GET /chief-of-staff/models/setup/tasks`,
`picker-page.ts`; logic in `tasks.ts`). `TASKS` is the list the app routes
model calls by, each with the owner's tier (2026-11-24): Smallest for
matching, extraction and LinkedIn invitations and messages; Middle for
scoring, filling and checking forms, cover letters and free-text answers. No
task defaults to Strongest.

Only the user's own passed models (`readUserModels`) are offered:

- one passed model: every task uses it, with nothing to tap;
- more: each task is proposed the cheapest model at its tier (each model's
  tier from its price, `lookupTier`) and a fallback at that tier on another
  provider; where the user has none at the task's tier, the other
  non-Strongest tier, and the page says so ("a Middle model, since you have
  no Smallest model yet"). **Accept all with one tap** saves every proposal
  (`task_models`, `set_how` `accepted`). An accepted task follows its
  proposal: when the proposal changes (a model at another provider is
  added, say), the task shows the new one as proposed and keeps its accepted
  models until the next tap. A task the user changed is never overwritten;
- any task can be changed to any of the user's models, the Strongest
  included, the fallback on another provider or none.

Until a proposal is accepted or a model chosen, a task with several models
has none, and `callTask` refuses it (`no_model`) without sending anything.
`callTask` sends a task's call through `callModel` with its main model and
fallback, so a refusal (429, 408, 5xx, no reply), a failed credential or a
spent budget at the main provider is answered by the fallback, named in its
ledger row. Every query is scoped to the signed-in user.

Checked live in M2 steps 4 and 8 on the owner's accounts after T10.
