// The vendors' own price sources, with the page each was built from and the
// date that page was read. Re-read the page when changing a reader.

import type { SourceId } from "./types";

export interface SourceInfo {
  id: SourceId;
  label: string;
  docs: string;
  docsRead: string;
}

export const SOURCES: Record<SourceId, SourceInfo> = {
  "azure-retail": {
    id: "azure-retail",
    label: "Azure Retail Prices API, service Foundry Models",
    // "This API gives you an unauthenticated experience to get retail rates
    // for all Azure services."
    docs: "https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices",
    docsRead: "2026-11-24",
  },
  "aws-price-list": {
    id: "aws-price-list",
    label: "AWS price-list files, offers AmazonBedrockFoundationModels and AmazonBedrock",
    // Public files over plain HTTPS, no account.
    docs: "https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api-fetching-price-list-files-manually.html",
    docsRead: "2026-11-24",
  },
  "google-catalog": {
    id: "google-catalog",
    label: "Google Cloud Billing Catalog API, service Vertex AI",
    // services.skus.list; an API key is required (403 without one).
    docs: "https://docs.cloud.google.com/billing/docs/reference/rest/v1/services.skus/list",
    docsRead: "2026-11-24",
  },
  "maintainer-read": {
    id: "maintainer-read",
    label: "Marketplace listing, read by the maintainers",
    docs: "shell/prices/maintainer-read.json",
    docsRead: "2026-11-24",
  },
};

export const AZURE_RETAIL_URL =
  "https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20%27Foundry%20Models%27";
export const AWS_PRICING_BASE = "https://pricing.us-east-1.amazonaws.com";
export const AWS_OFFERS = ["AmazonBedrockFoundationModels", "AmazonBedrock"] as const;
// Vertex AI's service id in the Cloud Billing catalog. Confirmed against the
// Catalog API once the maintainers' key exists (T10).
export const GOOGLE_VERTEX_SERVICE = "C7E2-9256-1C43";
export const GOOGLE_CATALOG_BASE = "https://cloudbilling.googleapis.com/v1";
