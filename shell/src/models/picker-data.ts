// What Model for each task reads beside the task routes (picker-page.ts):
//
//   readToReady(db, plugins, userId) -> ToReady | undefined   where a strength with no Ready model gets one
//   readModelNames(db) -> nameOf                               the provider's names for models no longer offered

import { readCurrentCatalog } from "../prices/store";
import { strengthChip, type Tier } from "../prices/tiers";
import { PROVIDERS, type Provider } from "../prices/types";
import { isConnected, readCheck } from "../providers/check";
import { readConnection } from "../proxy/connections";
import type { PluginRegistry } from "../proxy/plugin";
import type { ToReady } from "./picker-page";
import { readTable } from "./ready";

// The first provider a plug-in serves: whether the user is connected to it,
// its credits page, and for each strength how many of its listed models
// need credit (the rows Providers' strip counts as Needs credit, by its one
// rule rowState), counted by the same strength chip as its rows.
export async function readToReady(db: D1Database, plugins: PluginRegistry, userId: string): Promise<ToReady | undefined> {
  const provider = PROVIDERS.find((p) => plugins[p]);
  if (!provider) return undefined;
  const credits = plugins[provider]!.connect.guide.credits;
  const connected = isConnected(await readConnection(db, userId, provider), await readCheck(db, userId, provider));
  if (!connected) return { provider, connected, needCredit: {} };
  const { rows } = await readTable(db, plugins, userId, provider);
  const needCredit: Partial<Record<Tier, number>> = {};
  for (const r of rows) {
    if (r.state !== "credit") continue;
    const chip = strengthChip({ tier: r.tier, input: r.price?.input, output: r.price?.output, free: r.free });
    if (chip && chip !== "Other fees") needCredit[chip] = (needCredit[chip] ?? 0) + 1;
  }
  return { provider, connected, needCredit, ...(credits ? { credits } : {}) };
}

export async function readModelNames(db: D1Database): Promise<(m: { provider: Provider; model: string }) => string | undefined> {
  const names = new Map(((await readCurrentCatalog(db))?.models ?? []).map((m) => [m.id, m.name]));
  return (m) => {
    const name = names.get(m.model);
    return name && name !== m.model ? name : undefined;
  };
}
