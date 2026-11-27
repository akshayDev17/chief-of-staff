// One plain offer row and a model's shown test, for rendering the table's
// parts without a database.
import type { ShownTest } from "../src/models/test-all";
import type { OfferRow } from "../src/models/test-model";

export type ShownLatest = Exclude<ShownTest, { state: "testing" }>;

export const listOfferRow = (model: string): OfferRow => ({
  model,
  location: "global",
  price: { input: 0.1, output: 0.5, source: "openrouter-models", dateRead: "2026-11-27", stale: false },
  tier: "Smallest",
  free: false,
  callable: true,
  router: false,
  accountLeftOut: false,
  notes: [],
});
