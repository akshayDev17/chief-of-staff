// What Model for each task reads beside the task routes (picker-page.ts):
//
//   readToTest(db, plugins, userId) -> ToTest | undefined   where a strength with no usable model gets one
//   readModelNames(db) -> nameOf                             the provider's names for models no longer usable

import { readCurrentCatalog } from "../prices/store";
import { strengthChip, type Tier } from "../prices/tiers";
import { PROVIDERS, type Provider } from "../prices/types";
import { isConnected, readCheck } from "../providers/check";
import { readConnection } from "../proxy/connections";
import type { PluginRegistry } from "../proxy/plugin";
import type { ToTest } from "./picker-page";
import { blockKind, listOffer } from "./test-model";
import { readLatestTests } from "./usable";

// The first provider a plug-in serves: whether the user is connected to it,
// and for each strength how many of its listed models the user can test and
// has not tested yet on the current key, counted by the same strength chip as
// its rows.
export async function readToTest(db: D1Database, plugins: PluginRegistry, userId: string): Promise<ToTest | undefined> {
  const provider = PROVIDERS.find((p) => plugins[p]);
  if (!provider) return undefined;
  const connected = isConnected(await readConnection(db, userId, provider), await readCheck(db, userId, provider));
  if (!connected) return { provider, connected, untested: {} };
  const [rows, latest] = await Promise.all([listOffer(db, plugins, userId, provider), readLatestTests(db, userId, provider)]);
  const untested: Partial<Record<Tier, number>> = {};
  for (const r of rows) {
    const test = latest.get(r.model);
    if (blockKind(r) || (test && !test.earlierKey)) continue;
    const chip = strengthChip({ tier: r.tier, input: r.price?.input, output: r.price?.output, free: r.free });
    if (chip && chip !== "Other fees") untested[chip] = (untested[chip] ?? 0) + 1;
  }
  return { provider, connected, untested };
}

export async function readModelNames(db: D1Database): Promise<(m: { provider: Provider; model: string }) => string | undefined> {
  const names = new Map(((await readCurrentCatalog(db))?.models ?? []).map((m) => [m.id, m.name]));
  return (m) => {
    const name = names.get(m.model);
    return name && name !== m.model ? name : undefined;
  };
}
