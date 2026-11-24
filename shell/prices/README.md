# The price table (T11, design-v3 1.3)

No user ever types a price. The shell Worker keeps one price table, refreshed
from the vendors' own price sources, in D1 (`migrations/0000_create_price_table.sql`).

- **Rows.** One provider, one model, one deployment type and region, one kind of
  token (input, cached input, cache write, 1-hour cache write, output), each
  with long-prompt and batch flags, in USD per million tokens, with its source
  and date read.
- **Refresh.** Cron `0 6 * * *` reads every source (`src/prices/refresh.ts`)
  and stores a dated snapshot beside the last 14. A failed source keeps its
  last good rows with their own date read, marked stale, and raises a
  refresh-failed alert. A read under half the size of the last good one counts
  as failed. Two listings giving one row different prices keep the higher one,
  flagged, and raise an alert. `rollBackLatestSnapshot` returns the table to
  the previous snapshot.
- **Lookup** for the proxy (T12): `lookupPrice(db, { provider, model, location, tokenKind, longPrompt?, batch? })`
  returns `{ usdPerMTok, source, dateRead, stale }`, or `undefined` for "no price yet".
- **Tiers** come from the input price (`src/prices/tiers.ts`): Smallest under
  $0.50, Middle $0.50 to under $2.50, Strongest $2.50 and up.
- **Admin · Price table** is at `GET /admin/price-table`. It is owner only, and
  T15 adds the sign-in.
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
are left out. An Azure meter whose name does not give a model, a token kind and
a deployment type is counted as "not mapped" on the page and left out. On
2026-11-24 that was 810 of the Retail API's token meters. Most are older
regional meters with no deployment type (Phi, for example), plus the unnamed
"Model 6" and "Model 7" Kimi meters.

## Families each source lists (read 2026-11-24)

| Family | Foundry (Retail API) | Bedrock (price-list files) | Vertex AI (Catalog API) |
| --- | --- | --- | --- |
| Claude | Not listed. Read by the maintainers from Marketplace listings (11 models) | 32 models, Claude 2.0 to Opus 5.5 | Waits on T10's key; Google's public SKU list shows Claude |
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
`checkMaintainerEntries` refuses an entry without either. The tests run it, so
CI does too. The prices were read on 2026-11-24 through the Marketplace catalog
API that backs each listing (`read_via`). Cron `0 7 * * 1` raises the weekly
reminder to read every listing again.
