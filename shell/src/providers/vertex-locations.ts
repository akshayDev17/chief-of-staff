// The app's default Vertex AI location for each model (T16, design-v3 1.2:
// "on Vertex AI a specific regional endpoint, since its global endpoint
// supports fewer models"), then Global. Read by the Vertex AI plug-in, which
// calls the model there, and by the tier rule (src/prices/tiers.ts), which
// prices it there. It has no imports, so the price code reads it without the
// plug-in.
//
// The locations come from each model's own page (Google's model pages under
// docs.cloud.google.com/gemini-enterprise-agent-platform/models/, read
// 2026-11-25, no page dates): Claude 4.7 and later and the Gemini models
// list only the `us` and `eu` multi-regions and Global ("Multi-region
// endpoints support all Claude models with versions 4.7 and later"); the
// older Claude models list single regions. Keyed by the price table's names.
const MULTI_REGION = ["us", "eu", "global"];
export const VERTEX_LOCATIONS: Readonly<Record<string, readonly string[]>> = {
  "Claude Haiku 5.5": MULTI_REGION,
  "Claude Sonnet 5.5": MULTI_REGION,
  "Claude Opus 5.5": MULTI_REGION,
  "Claude Sonnet 5": MULTI_REGION,
  "Claude Opus 5": MULTI_REGION,
  "Claude Fable 5.2": MULTI_REGION,
  "Claude Fable 5.1": MULTI_REGION,
  "Claude Fable 5": MULTI_REGION,
  "Claude Opus 4.8": MULTI_REGION,
  "Claude Opus 4.7": MULTI_REGION,
  "Claude Opus 4.6": ["us-east5", "europe-west1", "asia-southeast1", "global"],
  "Claude Opus 4.5": ["us-east5", "europe-west1", "asia-southeast1", "global"],
  "Claude Sonnet 4.6": ["us-east5", "europe-west1", "asia-southeast1", "global"],
  "Claude Haiku 4.5": ["us-east5", "europe-west1", "global"],
  // Standard pay-as-you-go: "global" and the us and eu multi-regions.
  "Gemini 3.5 Flash": MULTI_REGION,
  "Gemini 3.5 Flash Lite": MULTI_REGION,
  "Gemini 3.8 Flash": MULTI_REGION,
  "Gemini 4 Hydrogen": MULTI_REGION,
};

// The app's default Vertex AI location for a model; undefined for a model
// the app names none for. The tier rule (src/prices/tiers.ts) prices here.
export const vertexDefaultLocation = (model: string): string | undefined => VERTEX_LOCATIONS[model]?.[0];

