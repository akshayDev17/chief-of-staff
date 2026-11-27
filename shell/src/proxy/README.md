# The model proxy (T12, design-v3 1.4, 1.7, 1.8)

Every model call goes through `callModel` (`proxy.ts`), straight to the
user's own provider account (OpenRouter, the one provider). There is no AI
Gateway: the ledger is the app's count, and OpenRouter's own records (its
Activity page and each generation's record) are the independent check.

## Provider plug-ins

The core knows no provider. A plug-in (`plugin.ts`) supplies its Connect
method (`connect`, see `src/providers/README.md`), its price source
(`priceSource`) and its caller:

- `connectionFields`: the only fields its connection record may hold, none
  secret (for OpenRouter, how it was made and the key's SHA-256);
- `mintCredential(connection, { userId })`: the credential for one call, for
  that user alone (OpenRouter: the key OpenRouter issued, opened from the
  user's vault), kept in memory for that call and never stored again or
  logged;
- `call(...)`: the provider's own request, returning the status, the body
  untouched, the provider's ID for the call, and the usage figures (uncached
  input, cached input, 5-minute and 1-hour cache writes, output; disjoint
  counts), whether the call reached long-prompt prices, and the cost the
  reply reports;
- `version`: recorded on every ledger row.

The one real plug-in is OpenRouter's (`src/providers/openrouter.ts`);
`test/test-plugin.ts` is the test-only one. A refusal the plug-in reads as
the key removed (`connect.classify` says `not_set_up`: OpenRouter's 401, or
no key in the vault) records the connection as revoked, for T49's alert
(`src/providers/revoked.ts`).

## What the proxy does with a call

1. Refuses a model the plug-in cannot call (`not_callable`, with the
   plug-in's `notCallableReason`): one OpenRouter no longer lists, or cannot
   be priced. Nothing is sent.
2. Prices it: the model needs an input and an output list price in the
   current price table (one read of its rows, `modelPrices`), else it is
   refused (`no_price`).
3. Enforces the provider's monthly budget: none set is refused (`no_budget`),
   except for the Connect test call and Test all models (`sendTestCall`),
   which run before budgets are set; the user's spend at that provider since
   00:00 UTC on the 1st reaching it is refused (`budget_spent`) until the 1st,
   with the date it resumes. The call that crosses the budget is the last one:
   the check runs before each call, whose cost is known only from the reply.
4. Reads the user's connection (`not_connected`) and mints a credential
   (`credential_failed`; without `VAULT_KEY`, the app's own side is named as
   missing).
5. Sends the call and writes one ledger row (`model_calls`), answered or not.
   Its cost is the cost the reply reports (OpenRouter's `usage.cost`, plus the
   upstream cost when the user's account used its own provider key), what the
   user is billed (`cost_source` `reported`). Only when the reply reports none
   is it costed from the price table (`list_price`): every kind at its own
   row, the long-prompt rows when the prompt reached them; a kind with no row
   of its own never below what the provider charges (cached input at the
   input price, anything else at the dearest rate the table lists for the
   model), named on the row (`costed_conservatively`) with a `price_missing`
   alert on Admin · Price table, at most one a UTC day for each model and
   token kind. A call that used tokens adds the model's fee per call (its
   `request` row), and output is priced at the dearer of the completion and
   reasoning rates (src/prices/openrouter.ts). The row also keeps OpenRouter's generation ID
   (`provider_call_id`).
6. Falls back once, to the task's fallback, another model, when the provider
   refuses or fails the main call (408, 429, 5xx, or no reply). The fallback
   passes every check above, and its ledger row carries `fallback` 1 and the
   reason. With one provider, a spent budget, no credits or a missing key stop
   the fallback too; a fallback on another provider would also answer a spent
   budget or a failed credential at the main model's provider. A setup
   refusal and the request's own fault (another 4xx) are returned as they are.

No prompt, reply or credential is logged or stored anywhere.

## How token honesty is checked

Per-provider bill checks (T118) no longer apply. Each ledger row's tokens and
cost are OpenRouter's own figures from its reply, counted with the model's
native tokenizer, and each row keeps OpenRouter's generation ID. The check is
OpenRouter's own records: its Activity page (https://openrouter.ai/activity,
filterable by model and by key, so the "Chief of staff" key alone) and each
generation's record (`GET https://openrouter.ai/api/v1/generation?id=<provider_call_id>`
with the user's key: `total_cost`, `tokens_prompt`, `tokens_completion`).
## Budgets

One monthly budget per user per provider (`provider_budgets`), required, with
no default, no daily and no per-model budget. Models › Setup › Budgets
(`GET`/`POST /chief-of-staff/models/setup/budgets`, `budgets-page.ts`) shows each connected
provider with a suggestion worked out from the dearest picked model's list
price (`user_models`, written by T17) and the design's tokens per application
(`TOKENS_PER_APPLICATION` in `budgets.ts`, from design-v3 12.2) at the
applications a day the user plans (5 until they say), marked "estimate" with
the date its prices were read. The user accepts it or types their own.

### The budget bar

Once the budget is set, Budgets shows the month's spend as one bar
(`budget-bar.ts`; AKS-136, reworked for OpenRouter). The Providers page does
not show it; design-v3 section 1.8 says where else it will appear. The bar has
three parts:

- **Solid, spent as OpenRouter reports it**: the app's key's own figure for
  the current UTC month, `usage_monthly` plus `byok_usage_monthly` from
  `GET https://openrouter.ai/api/v1/key`, read on each page view, server side,
  with the key from the user's vault. The key never reaches the browser.
- **Striped, counted by the app but not in OpenRouter's figure yet**: the
  ledger's count this month beyond that figure. OpenRouter's docs (read
  2026-11-27) say nothing about how soon a call shows in the key's figures, so
  the stripe stays. It is usually $0. It also holds calls made with an earlier
  key before the user connected again.
- **Empty, budget left**: the budget less the larger of the two counts.

Under the bar the page shows the app's own count, which is what stops calls,
and any gap between that count and OpenRouter's figure. When the key has its
own credit limit on OpenRouter, the page shows that limit and what is left of
it, with links to the key's page there. The note is a warning when the key's
limit would refuse calls before the budget runs out. When OpenRouter's figure
cannot be read, the page says why (OpenRouter did not answer, refused the
request with a given status, or sent a reply with no monthly figure) and the
bar shows the app's own count. Hovering over, tapping or tabbing to a part of
the bar labels it, with a link to OpenRouter's Activity page
(https://openrouter.ai/activity).

## Connections and the vault

`connections.ts` is the only code that writes (the Connect check,
`src/providers/check.ts`) or reads (the proxy) `provider_connections`, and it
refuses any field the plug-in does not declare. `src/vault.ts` is the per-user
vault for what is secret: each user's own AES-256-GCM key, stored wrapped by
the one vault key (the Worker secret `VAULT_KEY`), with the user and item name
bound into every seal. It holds the key OpenRouter issued the app for the
user, and its PKCE verifier while the user is on OpenRouter's page
(`src/providers/secrets.ts`); later the portal passwords and the Gmail token.
No user ever pastes a key: the app never asks for one.
