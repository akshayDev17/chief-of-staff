# The model proxy (T12, design-v3 1.4, 1.7, 1.8)

Every model call goes through `callModel` (`proxy.ts`), straight to the
user's own provider. There is no AI Gateway: the ledger is the app's count,
and each provider's own console and bill are the independent check.

## Provider plug-ins

The core knows no provider. A plug-in (`plugin.ts`) supplies:

- `connectionFields`: the only fields its connection record may hold, none
  secret (an AWS role ARN and external ID, a Microsoft tenant ID and endpoint,
  a Google project ID);
- `mintCredential(connection)`: a short-lived credential from that record,
  kept in memory for one call and never stored or logged;
- `call(...)`: the provider's own request, returning the status, the body
  untouched and the usage figures (uncached input, cached input, 5-minute and
  1-hour cache writes, output; disjoint counts) and whether the provider billed
  the call at its long-prompt rates;
- `version`: recorded on every ledger row.

T16 writes the three real plug-ins and the OpenID Connect issuer they mint
from. `test/test-plugin.ts` is the test-only one. The Worker has no plug-in
registered until then, so every call is refused `no_plugin`.

## What the proxy does with a call

1. Prices it: the model needs an input and an output list price at its
   location in the current price table (`lookupPrice`, T11), else it is refused
   (`no_price`). Once the reply is in, every kind of token it used is costed
   at its own row: the long-prompt rows when the provider billed at them, and
   the 5-minute and 1-hour cache writes each at theirs. A kind the call used
   with no row of its own is costed so it can never be below what the vendor
   charges: cached input at the input price, anything else at the dearest
   rate the table lists for the model at its location (input, output and cache
   writes, at either prompt tier). The ledger row names each such kind and the
   rate used (`costed_conservatively`), and the maintainers get a
   `price_missing` alert on Admin · Price table.
2. Enforces the provider's monthly budget: none set is refused (`no_budget`);
   the user's spend at that provider since 00:00 UTC on the 1st reaching it is
   refused (`budget_spent`) until the 1st, with the date it resumes. The call
   that crosses the budget is the last one: the check runs before each call,
   whose cost is known only from the reply.
3. Reads the user's connection (`not_connected`) and mints a credential
   (`credential_failed`).
4. Sends the call and writes one ledger row (`model_calls`), answered or not.
5. Falls back once, to the task's fallback on another provider, when the main
   provider's budget is spent, its credential fails, or it refuses or fails the
   call (408, 429, 5xx, or no reply). The fallback passes every check above
   within its own provider's budget, and its ledger row carries `fallback` 1
   and the reason. A setup refusal (no budget, no price, not connected) and the
   request's own fault (another 4xx) are returned as they are.

No prompt, reply or credential is logged or stored anywhere.

## Budgets

One monthly budget per user per provider (`provider_budgets`), required, with
no default, no daily and no per-model budget. Models › Setup › Budgets
(`GET`/`POST /models/setup/budgets`, `budgets-page.ts`) shows each connected
provider with a suggestion worked out from the dearest picked model's list
price (`user_models`, written by T17) and the design's tokens per application
(`TOKENS_PER_APPLICATION` in `budgets.ts`, from design-v3 12.2) at the
applications a day the user plans (5 until they say), marked "estimate" with
the date its prices were read. The user accepts it or types their own.

## Connections and the vault

`connections.ts` is the only code that writes (T16's Connect methods) or reads
(the proxy) `provider_connections`, and it refuses any field the plug-in does
not declare. `vault.ts` is the per-user vault for what is secret (pasted keys,
none in v1; later portal passwords and the Gmail token): each user's own
AES-256-GCM key, stored wrapped by the one vault key in Secrets Store, with
the user and item name bound into every seal.
