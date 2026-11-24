// The providers' default rate limits, read from their own pages and dated,
// shown beside the price table. Where a page states no number, the row says so
// rather than guessing.

export interface QuotaNote {
  provider: string;
  limits: string;
  page: string;
  read: string;
}

export const QUOTAS: QuotaNote[] = [
  {
    provider: "Foundry (Azure OpenAI models)",
    limits:
      "Global Standard, per model, by the subscription's quota tier: Tier 1 250 requests and 250,000 tokens a minute (gpt-6-sol, gpt-6-astra, gpt-6-luna); Tier 2 1,000 and 1,000,000; Tier 6 15,000 and 15,000,000 (gpt-6-sol). Free Tier subscriptions cannot raise quota.",
    page: "https://learn.microsoft.com/en-us/azure/foundry/openai/quotas-limits",
    read: "2026-11-24 (page updated 2026-08-20)",
  },
  {
    provider: "Foundry (other models sold directly or by partners)",
    limits:
      "\"Rest of models\": 400,000 tokens, 1,000 requests a minute, 300 concurrent requests. The page names no separate default for Claude; increases for Anthropic models are requested in the portal.",
    page: "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/quotas-limits",
    read: "2026-11-24 (page updated 2026-11-24)",
  },
  {
    provider: "Bedrock",
    limits:
      "Tokens a minute in each supported region, cross-region and global cross-region inference alike: Claude Opus 5.5 30,000,000; Claude Sonnet 5.5 6,000,000; Claude Haiku 5.5 10,000,000 (adjustable). On-demand (in-region) Claude Opus 5.5: 15,000,000, not adjustable. AWS says defaults \"might be updated depending on regional factors, account age, usage history\"; T10 reads the owner's account's own values in Service Quotas.",
    page: "https://docs.aws.amazon.com/general/latest/gr/bedrock.html",
    read: "2026-11-24 (no date on the page)",
  },
  {
    provider: "Vertex AI",
    limits:
      "Google's generative AI quotas page lists per-minute quotas per base model and region (for example 34,000,000 image-input tokens a minute) and gives no default for Claude or other partner models; T10 reads them from the owner's project in the console.",
    page: "https://docs.cloud.google.com/vertex-ai/generative-ai/docs/quotas",
    read: "2026-11-24 (no date on the page)",
  },
];
