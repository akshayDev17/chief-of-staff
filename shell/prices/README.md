# The price table (T11, design-v3 1.3)

No user ever types a price. The shell Worker keeps one price table, refreshed
from the vendors' own price sources, in D1 (`migrations/0000_create_price_table.sql`).

- **Rows.** One provider, one model, one deployment type and region, one kind of
  token (input, cached input, cache write, 1-hour cache write, output), each
  with long-prompt and batch flags, in USD per million tokens, with its source
  and date read.
- **Refresh.** Cron `0 6 * * *` reads every source (`src/prices/refresh.ts`)
  and stores a dated snapshot; the newest 14 are kept. A failed source keeps its
  last good rows with their own date read, marked stale, and raises a
  refresh-failed alert. A source that answers stores what the vendor lists,
  however few rows: a model no longer listed has no price yet, and the page
  shows how many rows each source added and dropped against the previous
  snapshot. A snapshot's header and rows are written in one transaction, so a
  failed write leaves the previous snapshot current and raises a
  refresh-failed alert. Two listings giving one row different prices keep the
  higher one, flagged, and raise an alert.
- **Rollback.** After a bad refresh a maintainer runs `make roll-back-prices`
  (`scripts/roll-back-prices.mjs --remote`, through Wrangler; it needs T10's
  Cloudflare token in `CLOUDFLARE_API_TOKEN`). It marks the newest snapshot
  rolled back, so the one before it is current again, records a rolled-back
  alert, and prints the snapshot now current. When no earlier snapshot would
  stay current it refuses: it changes nothing, records nothing, says so and
  exits non-zero, so a repeated or mistaken run never empties the table. Its SQL is
  `src/prices/rollback.ts`, the same statements `rollBackLatestSnapshot` runs
  in the Worker. `make rollback-check` (part of `make test`) runs the script
  against a fresh local D1.
- **Lookup** for the proxy (T12): `lookupPrice(db, { provider, model, location, tokenKind, longPrompt?, batch? })`
  returns `{ usdPerMTok, source, dateRead, stale }`, or `undefined` for "no price yet".
  `lookupTier(db, { provider, model })` returns the model's one tier at that
  provider, for Add a model (T17), the per-task picker (T18) and the usage
  ledger (T12).
- **Tiers** come from the input price (`src/prices/tiers.ts`): Smallest under
  $0.50, Middle $0.50 to under $2.50, Strongest $2.50 and up. A model has one
  tier at each provider, from its standard input price where the app runs it by
  default: Global on Foundry and Bedrock where offered (then data zone or
  cross-region, then a region), a region on Vertex AI (then Global). Within
  that deployment type the highest price counts. Every row of the model shows
  that tier, whatever its own price. On Vertex AI the price is the one at the
  app's default location for the model (`src/providers/vertex-locations.ts`,
  T16, from Google's model pages: the `us` multi-region for Claude 4.7 and
  later and for Gemini, `us-east5` for the older Claude models), then Global;
  a model the app names no default location for keeps the conservative rule,
  the highest regional price.
- **Admin · Price table** is at `GET /chief-of-staff/admin/price-table`. It is owner only: like
  every request to the Worker, it is behind the Cloudflare Access check
  (`src/access.ts`, T15).
- **Alerts** are shown on that page and logged. Push and email come with T49.

## Sources (pages read 2026-11-24)

| Provider | Source | Credentials |
| --- | --- | --- |
| Foundry | Azure Retail Prices API, service "Foundry Models", every region ([docs](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)) | None ("an unauthenticated experience") |
| Foundry, Claude | `maintainer-read.json`, read from each model's Microsoft Marketplace listing (pay-as-you-go plan meters) | None |
| Bedrock | AWS price-list files, offers `AmazonBedrockFoundationModels` and `AmazonBedrock`, every region ([docs](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api-fetching-price-list-files-manually.html)) | None |
| Vertex AI | Cloud Billing Catalog API, `services/C7E2-9256-1C43/skus` ([docs](https://docs.cloud.google.com/billing/docs/reference/rest/v1/services.skus/list)) | The maintainers' API key, Worker secret `GOOGLE_BILLING_API_KEY` (arrives with T10) |

Rows read on demand at the standard rate are kept. Flex, priority, ultrafast,
provisioned, reserved, fine-tuning, image, audio, realtime and embedding meters
are left out, as are the AWS Marketplace "100K" editions of Claude 2.0 and
Claude Instant (`src/prices/aws.ts`), which share Bedrock's model names but
price a different product. An Azure meter whose name does not give a model, a
token kind and a deployment type is counted as "not mapped" on the page and left out. On
2026-11-24 that was 810 of the Retail API's token meters. Most are older
regional meters with no deployment type (Phi, for example), plus the unnamed
"Model 6" and "Model 7" Kimi meters.

## Families each source lists (read 2026-11-24)

| Family | Foundry (Retail API) | Bedrock (price-list files) | Vertex AI (Catalog API) |
| --- | --- | --- | --- |
| Claude | Not listed. Read by the maintainers from Marketplace listings (12 models) | 32 models, Claude 2.0 to Opus 5.5 | Waits on T10's key; Google's public SKU list shows Claude |
| OpenAI GPT (incl. codex, o-series) | 76 models | 14 models (GPT-5.4 to GPT-6.2) | Waits on T10. GPT-6 is Private Preview, and Google's partner pricing page lists only gpt-oss |
| gpt-oss | 2 | 4 | Waits on T10 |
| Gemini | Not offered | Not offered (Google models there are Gemma) | Waits on T10 |
| Grok (xAI) | 10 | 3 | Waits on T10 |
| DeepSeek | 20 (incl. Fireworks-hosted) | 3 | Waits on T10 |
| Kimi (Moonshot) | 16 (incl. Fireworks and Baseten) | 3 | Waits on T10 |
| GLM (Z.ai) | 9 (Fireworks and Baseten) | 3 | Waits on T10 |
| Mistral | 4 | 14 | Waits on T10 |
| Llama (Meta) | 2 | 14 | Waits on T10 |
| Cohere | 2 | 4 | Waits on T10 |
| MiniMax | 2 (Fireworks) | 3 | Waits on T10 |
| Nemotron (NVIDIA) | 2 (Fireworks) | 4 | Waits on T10 |
| MAI (Microsoft) | 3 | Not listed | Not listed |
| Nova (Amazon) | Not listed | 7 | Not listed |
| Gemma (Google) | Not listed | 6 | Waits on T10 |
| Qwen | Not listed | 8 | Waits on T10 |
| Palmyra (Writer), Jamba and Jurassic (AI21) | Not listed | 3, 3, 2 | Waits on T10 |

The only family sold just through a marketplace listing is Foundry's Claude.

## Maintainer-read rows

`maintainer-read.json` is changed only through a reviewed pull request. Every
entry needs `listing` (the listing address) and `date_read`, and
`checkMaintainerEntries` refuses an entry without either. It also refuses an
entry without a region, with a deployment other than `global`, `data-zone` or
`regional`, or with a meter whose `long_prompt` is not `true` or `false`. The
tests run it, so
CI does too. The prices were read on 2026-11-24 (Claude Haiku 4.5 on 2026-11-25)
through the Marketplace catalog API that backs each listing (`read_via`). Cron
`0 7 * * 1` raises the weekly reminder to read every listing again.
