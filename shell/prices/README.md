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
  the newest model of its line), a model that takes no text, a model that
  also gives audio, images or video (its token prices are not its whole
  price). Only models the app can call get price rows. Free models
  (`isTrulyFreeTextModel`: only text out, every listed price 0) can be chosen.
  On 2026-11-27 the API listed 477 models, 434 of them choosable.
- **Refresh.** Cron `0 6 * * *`, and Refresh model list on the Connect screen
  (at most once a minute); a second Cron Trigger, `* * * * *`, runs the
  background host read (below), which does nothing when no hosts wait. Each
  stores a dated snapshot; the newest 14 are kept. A failed read keeps the last good rows with their own date read,
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
- **Strength** (the tier, `src/prices/tiers.ts`, rule B90 of
  `data/cos-models-tier-ranges/report.md`): each model's typical price is its
  input and output price blended 10:1 at the median of its standard-speed
  hosts that take tools and are up, from its endpoints list
  (`GET /api/v1/models/<id>/endpoints`, no key). Two lines, the 33⅓rd and the
  90th percentile of that price over every priced tool-use model that is
  neither free nor a router, rounded to the ladder $0.10, $0.15, $0.20,
  $0.30, $0.50, $0.75, $1, $1.50, ..., make Smallest, Middle and Strongest. A
  free model is Smallest; a router's figure is the same blend of its cap. The
  figures are stored beside each snapshot (`model_price_figures`,
  `migrations/0016_add_strength_figures.sql`) and each month's lines in
  `strength_lines`, worked out at the month's first daily refresh (before
  any month has them, at the first refresh that leaves no hosts waiting, or
  by the background read's last batch). Every reader goes through `src/prices/strength.ts`;
  a snapshot with no figures takes its headline prices until the background
  host read stores them.
- **Host reads.** The daily refresh reads every tiered model's endpoints list,
  six at a time. Refresh model list needs only the new ones, those whose
  headline price changed and those last not read, and reads them while the
  user waits only when there are at most `HOST_READS_NOW` (30); with more (the
  first Refresh after a release), it reads none, stores them at their headline
  price and records them in `price_host_reads` (migration 0017). Every minute
  the background read (`src/prices/host-reads.ts`) checks with one D1 read
  and no write; when the current snapshot's hosts wait, or it has no figures
  (one a previous Worker wrote), it takes them under a 15-minute lease, reads
  at most `HOST_READS_PER_RUN` (60) endpoints lists and stores those figures
  beside the same snapshot; the run that tries the last draws the first lines
  when no month has them. About 290 take five minutes. While hosts wait,
  Providers, Model for each task and the price table say so; Providers shows the count read and redraws in
  place when they land. A list that cannot be read gives the model its
  headline price.
- **Admin · Price table** is at `GET /chief-of-staff/admin/price-table`, owner
  only, behind the Cloudflare Access check (`src/access.ts`, T15). Beside the
  table, OpenRouter's rate limits as its limits page states them (no default
  number for paid models).
- **Alerts** are shown on that page and logged. Push and email come with T49.

The tables the previous Worker used (`price_rows`, `bedrock_catalogs`) are no
longer written, but are pruned with each snapshot and dropped in a later
contract release, once no Worker that reads them can run.
