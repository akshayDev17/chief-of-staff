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
   the S256 `code_challenge`, `state`, `key_label=Chief of staff` and `limit`:
   the user's monthly OpenRouter budget in the app, or $10 before one is set.
   The user can change the limit on OpenRouter's page.
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
4. The Connect test call runs by itself (below), and the account's own model
   list is read with the new key (`src/models/account-list.ts`).

**Disconnect** deletes the key and the verifier from the vault, the record,
the check and the account's model list; the models stop answering at once.
The app cannot revoke the key at OpenRouter: deleting a key ("Delete an
existing API key. Authenticate with a management key.", 403 "Only management
keys can perform this operation",
https://openrouter.ai/docs/api/api-reference/api-keys/delete-an-api-key.md,
read 2026-11-27) needs the account's management key, which the app never
holds. So the screen tells the user to delete the "Chief of staff" key at
https://openrouter.ai/settings/keys, with a link to the key's own page.

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
| 402 | your OpenRouter account or this key is out of credits |
| 403 | OpenRouter refused this request for your account (moderation, a guardrail, privacy settings) |
| 404 | that model ID doesn't exist here |
| 408, 429, 502, 503 | busy or out of quota, not a setup fault |
| other | OpenRouter refused the test call, in its own words |

Statuses from https://openrouter.ai/docs/api_reference/errors-and-debugging.md
(read 2026-11-27).

## The Connect check (`check.ts`)

After Connect, the test call runs by itself, on the plug-in's own test model
(`openai/gpt-6-luna`, $0.10 in and $0.50 out per million tokens on
2026-11-27; if OpenRouter stops listing it, the next of `TEST_MODELS`, else
the first model it lists that the app can call), never on a model the user
chose. Its reply is capped at 16 tokens. It is a real call through the proxy
(`sendTestCall`), priced and written to the ledger (task `test_call`); it
needs the model's price (it waits, and is tried again every 15 minutes, until
the price table has one) and no budget yet, and waits while one is set and
spent. A connection whose test call had passed and that then gets a 401 is
recorded as `revoked`, for T49's urgent alert. The cron (`* * * * *`) runs due
checks only for providers a plug-in serves: rows left from Bedrock, Vertex AI
or Foundry are never picked.

Each result is three lines, shown only to the user who made the call: the
plain reason, OpenRouter's own reply, the fix. "Ask Admin for help" (friends
only) records the item's name and the plain reason, never the reply.

## The issuer (`src/issuer.ts`)

The Worker is its own OpenID Connect issuer at
`<APP_ORIGIN>/chief-of-staff/oidc`, with its discovery document at
`/chief-of-staff/oidc/.well-known/openid-configuration` and its key set at
`/chief-of-staff/oidc/jwks.json`. No model provider reads it today: it is
kept, with its public paths and signing key, for the coming "Connect
Anthropic" build (Claude Platform OAuth with linked billing), which
authenticates with it through workload identity federation (the owner,
2026-11-27). Those two paths are the only ones served without the owner's
sign-in: the Worker exempts exactly them from its Access check, and the
owner's `portfolio-app` tool makes a second Access application on exactly
those two paths with a Bypass policy (README "Cloudflare Access"). Tokens are
RS256 and live 5 minutes.

### Rotating the issuer key

The key lives in one place, the Worker secret `ISSUER_KEYS`
(`{"signing": "<kid>", "keys": [<JWK>, ...]}`): every key in it is published,
and only `signing` signs. Old and new public keys are published together
until the old one can no longer be in use. Make the first key with
`node scripts/issuer-keys.mjs keys <dir>` (outside the repository), then run
each step on the owner's machine:

1. `node scripts/issuer-keys.mjs rotate <dir>/issuer-keys.json publish`, then
   `npx wrangler secret put ISSUER_KEYS < <dir>/issuer-keys.json`. A new key
   is published beside the old one, which still signs.
2. A day later, when every relying party has fetched the new key set: the
   same with `sign`. The new key signs; both stay published.
3. A day later, when every token signed with the old key has expired: the
   same with `retire`. Only the new key is published.

The tests run a whole rotation (`test/issuer.test.ts`), and
`make issuer-keys-check` runs the script itself.

## What the owner sets up

| Name | Kind | What |
| --- | --- | --- |
| `APP_ORIGIN` | variable | `https://<host>`, no path: OpenRouter's consent page returns under `<APP_ORIGIN>/chief-of-staff`, and the issuer lives there. Set in `shell/wrangler.jsonc` `"vars"`, so every release ships it |
| `VAULT_KEY` | secret | the vault key: 32 random bytes, base64 (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" \| npx wrangler secret put VAULT_KEY`). It unwraps every user's vault key: never rotate it casually. Until it is set, Connect OpenRouter says the app's own side is missing `VAULT_KEY` |
| `ISSUER_KEYS` | secret | the issuer's keys (above) |

No GitHub variable and no client secret is needed: PKCE has no client
secret, the callback is built from `APP_ORIGIN`, and the app's name is fixed
in code. The secrets are stored with `npx wrangler secret put`, which a
release keeps.

## Release units (design-v3 1.4, ADR-017)

- **The plug-in** ships in the Worker and rolls back with it; its version
  label (`openrouter-2026-11-27`) is on every ledger row it writes.
- **The issuer key** has its own rotation cycle (above).
- **The vault key** is set once; rotating it means re-sealing every vault
  item, a data migration (`src/data-migrations.ts`), never a casual change.
