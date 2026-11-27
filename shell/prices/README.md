# The price table (T11, design-v3 1.3)

No user ever types a price. The shell Worker keeps one price table, refreshed
from OpenRouter's own models API, in D1 (`migrations/0000_create_price_table.sql`
for the snapshots and alerts, `migrations/0012_openrouter_only.sql` for the
rows, `model_price_rows`, and OpenRouter's model list, `openrouter_catalogs`).

- **Source.** `GET https://openrouter.ai/api/v1/models`, no key
  (https://openrouter.ai/docs/api-reference/list-available-models, read
  2026-11-27): "All pricing values are in USD per token/request/unit. A value
  of "0" indicates the feature is free"; a model's `pricing` is "Pricing from
  the top provider for this model". `src/prices/openrouter.ts` reads it.
- **Rows.** One model and one kind of token (input from `prompt`, output from
  `completion`, cached input from `input_cache_read`, cache write from
  `input_cache_write`, 1-hour cache write from `input_cache_write_1h`), in USD
  per million tokens, with the source and the date read. OpenRouter routes each
  call itself, so every row is `global`. A model priced higher above a prompt
  length (`overrides` with `min_prompt_tokens`) gets long-prompt rows at the
  dearest of those prices; a model priced by time of day keeps the dearest
  hour's price as its standard row. So a call costed from the table (only when
  OpenRouter's reply reports no cost, `src/proxy/README.md`) never counts less
  than OpenRouter can charge.
- **The model list.** Every model the API lists is kept with the snapshot,
  with its name, tool support (`supported_parameters`), retirement date
  (`expiration_date`) and, for a model the app cannot call, why: a router
  (`pricing.prompt` `-1`, priced by the model it picks), a `~` alias (moved to
  the newest model of its line), a model that takes or gives no text. Only
  models the app can call get price rows. Free (`:free`, $0) models can be
  chosen. On 2026-11-27 the API listed 477 models, 450 of them choosable.
- **Refresh.** Cron `0 6 * * *`, and Refresh model list on the Connect screen
  (at most once a minute). Each stores a dated snapshot; the newest 14 are
  kept. A failed read keeps the last good rows with their own date read,
  marked stale, and the last model list, and raises a refresh-failed alert. A
  read that answers stores what OpenRouter lists: a model no longer listed has
  no price yet, and the page shows how many rows were added and dropped against
  the previous snapshot. A snapshot's header, rows and model list are written
  in one transaction. Two listings giving one row different prices keep the
  higher one, flagged, and raise an alert.
- **Rollback.** After a bad refresh a maintainer runs `make roll-back-prices`
  (`scripts/roll-back-prices.mjs --remote`, through Wrangler; it needs the
  Cloudflare token in `CLOUDFLARE_API_TOKEN`). It marks the newest snapshot
  rolled back, so the one before it, with its model list, is current again,
  records a rolled-back alert, and prints the snapshot now current. When no
  earlier snapshot would stay current it refuses and changes nothing. Its SQL
  is `src/prices/rollback.ts`, the same statements `rollBackLatestSnapshot`
  runs in the Worker. `make rollback-check` (part of `make test`) runs the
  script against a fresh local D1.
- **Lookup** for the proxy (T12): `lookupPrice(db, { provider, model, location, tokenKind, longPrompt?, batch? })`
  returns `{ usdPerMTok, source, dateRead, stale }`, or `undefined` for "no
  price yet"; the proxy reads a model's rows once per call
  (`modelPrices`, `src/proxy/proxy.ts`). `lookupTier(db, { provider, model })`
  returns the model's one tier.
- **Tiers** come from the standard input price (`src/prices/tiers.ts`):
  Smallest under $0.50, Middle $0.50 to under $2.50, Strongest $2.50 and up.
- **Admin · Price table** is at `GET /chief-of-staff/admin/price-table`, owner
  only, behind the Cloudflare Access check (`src/access.ts`, T15). Beside the
  table, OpenRouter's rate limits as its limits page states them (no default
  number for paid models).
- **Alerts** are shown on that page and logged. Push and email come with T49.

The tables the previous Worker used (`price_rows`, `bedrock_catalogs`) are no
longer written, but are pruned with each snapshot and dropped in a later
contract release, once no Worker that reads them can run.
