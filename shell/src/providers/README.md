# Connecting the provider (T16, design-v3 1.4 to 1.6, ADR-018)

OpenRouter is the app's one model provider (the owner, 2026-11-27: "so delete
all the three: bedrock, gcp and foundry, and only have openrouter"). It is a
"Connect <Provider>" button backed by one plug-in, `openrouter.ts`; adding a
provider later is one more plug-in, and its button appears by itself.

Two rules hold for every provider (the owner, 2026-11-27): each user pays for
their own model use and the owner pays for no one else's; and no user ever
**gives** (pastes) a key or secret to the app. A user **authorizing** a key at
the provider, so the provider issues it to the app through its own consent
page, is allowed, and is not giving a key.

## Connect OpenRouter (`openrouter.ts`, `check.ts`)

OpenRouter's OAuth PKCE (https://openrouter.ai/docs/guides/overview/auth/oauth,
read 2026-11-27):

1. The user taps **Connect OpenRouter**. There is no field. The app makes a
   PKCE verifier (kept in the user's vault, never sent to the browser) and a
   state value (on the user's check row), and sends the user to
   `https://openrouter.ai/auth` with `callback_url`
   (`<APP_ORIGIN>/chief-of-staff/models/setup/providers/openrouter/consented`),
   the S256 `code_challenge`, `state`, `key_label` and `limit`. The label is
   dated, `Chief of staff · 2026-11-27 14:05:59 UTC` (UTC, when Connect was
   tapped), because every Authorize mints a new key (below). `limit` is
   the user's monthly OpenRouter budget in the app, or $10 before one is set.
   It is the key's own credit limit on OpenRouter, separate from the app's
   monthly budget: the user can change it, or give it a reset period (say
   monthly), on the key's page at OpenRouter, and the guide says so. A 402,
   or a 403 whose message names the key's limit, tells the user to raise or
   reset it there, with https://openrouter.ai/settings/keys and the key's own
   page.
2. The user signs in at OpenRouter and taps Authorize. OpenRouter sends them
   back with `code` and `state`. The state must be this user's and is spent
   once; the app then posts the code and verifier to
   `https://openrouter.ai/api/v1/auth/keys` and receives `{ key }`: "an API
   key tied to their account. Their requests are billed to their own
   OpenRouter credits". Codes last 10 minutes.
3. The key goes straight into the user's vault (`secrets.ts`, `src/vault.ts`:
   the user's own AES-256-GCM key, wrapped by the vault key `VAULT_KEY`). It
   is never shown, logged, put in an error message or sent to the browser.
   The connection record holds only `method` (`oauth_pkce`) and `key_hash`,
   the key's SHA-256, which names the key's own page on OpenRouter
   (`https://openrouter.ai/keys/<hash>`, as OpenRouter's PKCE page builds it).
4. No test call runs by itself (the owner, 2026-11-27). The account's own
   model list is read with the new key (`src/models/account-list.ts`; it costs
   nothing), and the user lands on the model test (`#test`), highlighted,
   with focus on its dropdown (below).

**Disconnect** deletes the key and the verifier from the vault, the record,
the check and the account's model list; the models stop answering at once.
The app cannot revoke the key at OpenRouter: deleting a key ("Delete an
existing API key. Authenticate with a management key.", 403 "Only management
keys can perform this operation",
https://openrouter.ai/docs/api/api-reference/api-keys/delete-an-api-key.md,
read 2026-11-27; "All key management endpoints are under `/api/v1/keys` and
require a Management API key",
https://openrouter.ai/docs/guides/overview/auth/provisioning-api-keys, read
2026-11-27) needs the account's management key, which the app never holds.
No OpenRouter page offers a key a way to delete itself, and `GET /api/v1/key`
returns no hash. So Disconnect's confirmation says "Also delete this key on
OpenRouter." with **Open its page**, `https://openrouter.ai/keys/<key_hash>`
from the record; the key never reaches the browser. The page Disconnect
returns to links https://openrouter.ai/settings/keys.

**A new key each time.** Reconnecting cannot reuse a key within OpenRouter's
documented flow: each Authorize trades a fresh code "for a user-controlled
API key", no parameter names an existing key, a key is returned only by the
exchange that made it, and listing keys needs a management key. So each key
carries its date in its label, and a collapsed "Why a new key each time"
under Connect says so.

## The caller

Chat Completions at `https://openrouter.ai/api/v1/chat/completions`, with the
user's key as `Authorization: Bearer`, the model set to the one chosen, and
OpenRouter's own model fallback (`models`, `route`) taken out, so a call runs
on exactly that model and the proxy's fallback rule alone decides. It sends
`HTTP-Referer: <APP_ORIGIN>/chief-of-staff` and
`X-OpenRouter-Title: Chief of staff`, OpenRouter's attribution headers
(https://openrouter.ai/docs/api-reference/authentication). A generation that
fails after it started answers 200 with an error in the body; that is read as
the failure it is.

Usage and cost come from the reply ("Full usage details are always included
automatically in every response",
https://openrouter.ai/docs/use-cases/usage-accounting; token counts "are
calculated using the model's native tokenizer",
https://openrouter.ai/docs/api-reference/overview; read 2026-11-27):

- uncached input: `prompt_tokens` less `prompt_tokens_details.cached_tokens`
  and `cache_write_tokens` (OpenAI's convention, which OpenRouter's caching
  example follows; the docs do not say it in words);
- cached input: `cached_tokens`; cache writes: `cache_write_tokens`, counted
  as 1-hour writes, the dearer kind, since OpenRouter does not split them;
- output: `completion_tokens`, reasoning included;
- cost: `usage.cost` (US dollars: "the base currency is US dollars",
  https://openrouter.ai/docs/faq), plus `cost_details.upstream_inference_cost`
  when the user's account sent the call through its own provider key
  (`is_byok`), so the ledger counts what the user pays;
- the reply's `id`, OpenRouter's generation ID, kept on the ledger row.

## Plain reasons

| Status | What the user sees |
| --- | --- |
| no key in the vault, 401 | the connection isn't set up yet, or was removed (Connect OpenRouter again) |
| 402 | needs credit on OpenRouter, with Add credits first; on a free model, OpenRouter asked for credit even for it |
| 403 | OpenRouter refused this request for your account (moderation, a guardrail, privacy settings) |
| "No endpoints found matching your data policy" (any status) | refused for your account: your OpenRouter privacy settings leave no provider for it, often a free model's; with a link to them |
| 404 | that model ID doesn't exist here |
| 429 "free-models-per-day" or "-per-min" | busy: OpenRouter's free-model limits (20 a minute; 50 a day under 10 credits bought, 1,000 from 10, https://openrouter.ai/docs/api-reference/limits, read 2026-11-27) |
| 408, 429, 502, 503 | busy or out of quota, not a setup fault |
| other | OpenRouter refused the test call, in its own words |

Statuses from https://openrouter.ai/docs/api_reference/errors-and-debugging.md
(read 2026-11-27).

## After Connect (`check.ts`, `page.ts`, `models-panel.ts`)

The owner's flow (2026-11-27): "the post connect step, where authorization
from openrouter succeeds, should be to scroll/highlight the testing section.
the testing section should have a model dropdown list, non-hardcoded, and then
when a user picks up a model, we should have a "test with <model name>?"
button suddenly getting enabled".

- Back from OpenRouter, the connection is **Connected** (the check row's state
  `passed`, which since 2026-11-27 means only that OpenRouter authorized the
  app). No model call is made. The page opens at `#test`, the model test,
  highlighted, with focus on its dropdown.
- The model test has one dropdown, OpenRouter's live list (every model it
  lists; the app holds no model ID of its own), reading "Choose a model", and
  a real `<button>`, disabled until a model is chosen, then reading
  "Test with <model>?". Choosing sends no request and loads no page; only the
  button does, and it runs that one model's test call (`models/add.ts`
  `addModel`). Test all models stays a separate action with its estimate and
  confirm.
- The provider is **usable** once one of the user's models has passed its
  test call ("Usable: 2 models passed"; before that, "Not usable yet").
- A test call that gets a 401 records the connection as `revoked` (removed on
  OpenRouter's side), for T49's urgent alert, and the page offers Connect
  OpenRouter again.

**The account line** reads `GET /api/v1/key` live with the key from the
vault, server side, on each view of the connected panel: whether the account
has ever bought credits (`is_free_tier`), who owns the key
(`organization_id`: the user's own account or an organization), the workspace
it spends in (`workspace_id`), the key's own limit and what is left of it, and
what the key has spent (`usage`, `usage_monthly`), with the free-model
requests left today (https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key.md,
read 2026-11-27). An account that never bought credits gets **Add credits**.
OpenRouter's authorize page lets the user pick the workspace the key is made
in (`workspace_id` preselects one, `required_workspace_id` locks it; the app
sends neither) and change its limit
(https://openrouter.ai/docs/guides/overview/auth/oauth), so a key made on an
account or workspace without credits gets 402 on every paid model; the line
shows which.

**Free** has one meaning everywhere (`src/prices/openrouter.ts`
`isTrulyFreeTextModel`): the model gives only text (`output_modalities`
exactly `["text"]`) and every price OpenRouter lists for it is 0, not only
`prompt` and `completion` but `request`, `image`, `audio`, `web_search`,
`internal_reasoning`, the cache prices, `overrides` and any field the app
does not know. A model that also gives audio, images or video is never
offered or tested: Google's Lyria music models are listed at "0" a token,
`output_modalities` ["text", "audio"], and are charged per clip or song.

Visible copy is the action lines; every explanation sits in a collapsed
"What this does" or "Details" (the owner, 2026-11-27: the old guide was far
too long). Each result shows one plain line and its one action first, with
OpenRouter's own reply, shown only to the user who made the call, collapsed.
"Ask Admin for help" (friends only) records the item's name and the plain
reason, never the reply.

## No issuer

The app had its own OpenID Connect issuer for the removed providers' workload
identity federation, then kept it the same day for a planned Connect
Anthropic. The owner parked Connect Anthropic (2026-11-27: "ok, so lets not
do the anthropic one just yet, lets get the openrouter one working at
least"), so nothing used it, and it was removed with its two public paths,
its `ISSUER_KEYS` secret and its key script. No path under `/chief-of-staff`
is served without the owner's sign-in.

## What the owner sets up

| Name | Kind | What |
| --- | --- | --- |
| `APP_ORIGIN` | variable | `https://<host>`, no path: OpenRouter's consent page returns under `<APP_ORIGIN>/chief-of-staff`. Set in `shell/wrangler.jsonc` `"vars"`, so every release ships it |
| `VAULT_KEY` | secret | the vault key: 32 random bytes, base64 (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" \| npx wrangler secret put VAULT_KEY`). It unwraps every user's vault key: never rotate it casually. Until it is set, Connect OpenRouter says the app's own side is missing `VAULT_KEY` |

No GitHub variable and no client secret is needed: PKCE has no client
secret, the callback is built from `APP_ORIGIN`, and the app's name is fixed
in code. The one secret is stored with `npx wrangler secret put`, which a
release keeps.

## Release units (design-v3 1.4, ADR-017)

- **The plug-in** ships in the Worker and rolls back with it; its version
  label (`openrouter-2026-11-27`) is on every ledger row it writes.
- **The vault key** is set once; rotating it means re-sealing every vault
  item, a data migration (`src/data-migrations.ts`), never a casual change.
