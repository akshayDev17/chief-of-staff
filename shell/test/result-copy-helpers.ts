// One plain row of the model table, for rendering the table's parts without
// a database: Ready unless `extra` says otherwise.
import type { TableRow } from "../src/models/ready";

export const listOfferRow = (model: string, extra: Partial<TableRow> = {}): TableRow => ({
  model,
  provider: "openrouter",
  location: "global",
  price: { input: 0.1, output: 0.5, source: "openrouter-models", dateRead: "2026-11-27", stale: false },
  tier: "Smallest",
  free: false,
  callable: true,
  router: false,
  accountLeftOut: false,
  notes: [],
  state: "ready",
  ...extra,
});
