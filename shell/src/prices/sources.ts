// The price source, with the page it was built from and the date that page
// was read. Re-read the page when changing the reader.

import type { SourceId } from "./types";

export interface SourceInfo {
  id: SourceId;
  label: string;
  docs: string;
  docsRead: string;
}

export const SOURCES: Record<SourceId, SourceInfo> = {
  "openrouter-models": {
    id: "openrouter-models",
    label: "OpenRouter models API",
    // "All pricing values are in USD per token/request/unit. A value of "0"
    // indicates the feature is free." No key is needed to read it.
    docs: "https://openrouter.ai/docs/api-reference/list-available-models",
    docsRead: "2026-11-27",
  },
};

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

// One model's hosts on OpenRouter, each with its own price (src/prices/openrouter.ts parseHosts).
export const openRouterEndpointsUrl = (model: string): string => `https://openrouter.ai/api/v1/models/${encodeURI(model)}/endpoints`;
