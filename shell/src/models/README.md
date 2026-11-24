# Add a model (T17, design-v3 1.5)

Models › Setup › Add a model (`GET /models/setup/add`, `page.ts`; logic in
`add.ts`). One tab per connected provider; its table lists every chat model
the current price table sells there at a listed price, plus the models the
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
the model ID (`connect.deploymentName`), and a user who named the deployment
differently changes it. Friend screens say "Foundry's name for the model".

**Pick** runs the model's test call by itself through the proxy's one
pipeline (`sendTestCall`), which prices it and writes its ledger row (task
`test_call`). The model is added (a `user_models` row, with the passed test
call's reply, tokens and cost) only when the call passes. It is refused, with
the three lines of design-v3 1.5 and nothing stored, when:

- the model has "no price yet" (no input and output price at its region): no
  call is made, because the budget stop needs a real price, and the proxy
  refuses a direct call to it too;
- the plug-in cannot call it (`connect.canCall`: Bedrock needs Bedrock's own
  ID for the model, `BEDROCK_MODEL_IDS`; Vertex AI calls Claude and Gemini);
- the reply names a different model than the one picked
  (`connect.replyModel`, `namesPickedModel`): Messages and Chat Completions
  `model`, Gemini's `modelVersion`; Bedrock's Converse names none;
- the provider refuses the call: the plug-in's plain reason, so a misspelt
  Foundry deployment shows "That deployment name or model ID doesn't exist
  here." with Foundry's own reply under it.

`readUserModels(db, userId)` returns the user's added models at every
provider: what the per-task picker (T18) offers. Every query is scoped to the
signed-in user.

## Waiting on T10 (checked live in M2 step 3)

Nothing here has called a real provider. Foundry's Chat Completions caller
(every Foundry model but Claude), Vertex AI's Gemini caller, the model each
vendor's reply names (and whether Foundry's names the model or echoes the
deployment), and Gemini's long-prompt threshold are built from the formats
and checked live in M2 step 3 on the owner's accounts.
