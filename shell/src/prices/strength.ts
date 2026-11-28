// The one place a model's strength is read (the rule: src/prices/tiers.ts):
// the figures stored beside the current price snapshot and the newest
// month's lines (src/prices/store.ts).
//
//   tieredModels(rows, catalog) -> TieredModel[]            the models a figure tiers
//   headlineFigures(rows, catalog, readAt) -> StoredFigure[] their figures at the headline price
//   readStrength(db, snapshot, given?) -> Strength           every figure, and the lines
//   strengthTier(strength, m) -> Tier | undefined            one model's tier, from them
//   readModelStrength(db, m) -> { tier?, figure? }           one model's, read on its own (the proxy)
//
// A snapshot the previous Worker wrote has no figures: until the next
// refresh stores them, its models' figures are their headline prices, the
// rule's own fallback, and the lines, before any month has them, are drawn
// from those figures. Nothing else ever tiers a model.

import type { OpenRouterCatalog } from "./openrouter";
import { currentSnapshot, readFigure, readFigures, readLatestLines, readSnapshotRows, readStoredCatalog, type Snapshot, type StoredFigure } from "./store";
import { capFigure, figureOf, linesOf, modelTier, type Lines, type Tier } from "./tiers";
import type { PriceRow, Provider } from "./types";

export const strengthKey = (m: { provider: Provider; model: string }): string => `${m.provider}|${m.model}`;

export interface TieredModel {
  provider: Provider;
  model: string;
  free: boolean;
  // The one price the models API lists for it (its standard rows).
  headline: { input: number; output: number };
}

// Each model's standard input and output price in `rows`, the dearest row
// of each kind, keyed by strengthKey.
export function headlinePrices(rows: readonly PriceRow[]): Map<string, { input: number; output: number }> {
  const out = new Map<string, { input?: number; output?: number }>();
  for (const r of rows) {
    if (r.longPrompt || r.batch || (r.tokenKind !== "input" && r.tokenKind !== "output")) continue;
    const key = strengthKey(r);
    const seen = out.get(key) ?? {};
    seen[r.tokenKind] = Math.max(seen[r.tokenKind] ?? 0, r.usdPerMTok);
    out.set(key, seen);
  }
  const priced = new Map<string, { input: number; output: number }>();
  for (const [key, p] of out) if (p.input !== undefined && p.output !== undefined) priced.set(key, { input: p.input, output: p.output });
  return priced;
}

// The models a figure tiers: every model in the app's list (it lists tool
// use) that is not a router and has an input and an output price, but a
// model at $0 a token that is not free ("Other fees": its token price says
// nothing of what it costs). A free model is among them, at 0.
export function tieredModels(rows: readonly PriceRow[], catalog: OpenRouterCatalog | undefined): TieredModel[] {
  const prices = headlinePrices(rows);
  return (catalog?.models ?? []).flatMap((m): TieredModel[] => {
    if (m.router || !m.tools) return [];
    const headline = prices.get(strengthKey({ provider: "openrouter", model: m.id }));
    if (!headline) return [];
    const free = m.free === true;
    if (!free && headline.input === 0 && headline.output === 0) return [];
    return [{ provider: "openrouter", model: m.id, free, headline }];
  });
}

// A tiered model's figure where its hosts were not read: its headline price,
// or 0 for a free model.
export const headlineFigure = (t: TieredModel, readAt: string): StoredFigure => ({
  provider: t.provider,
  model: t.model,
  free: t.free,
  ...figureOf(undefined, t.free ? { input: 0, output: 0 } : t.headline, readAt),
});

export const headlineFigures = (rows: readonly PriceRow[], catalog: OpenRouterCatalog | undefined, readAt: string): StoredFigure[] =>
  tieredModels(rows, catalog).map((t) => headlineFigure(t, readAt));

// The lines over a set of figures: every one but the free models'.
export const linesOver = (figures: readonly StoredFigure[], at: Date): Lines | undefined => linesOf(figures.filter((f) => !f.free).map((f) => f.usd), at);

export interface Strength {
  lines?: Lines;
  figures: Map<string, StoredFigure>;
}

// The current snapshot's figures and the lines in force. `given`: the
// snapshot's rows and model list where the caller has read them already.
export async function readStrength(
  db: D1Database,
  snapshot: Snapshot | undefined,
  given?: { rows?: PriceRow[]; catalog?: OpenRouterCatalog },
): Promise<Strength> {
  if (!snapshot) return { figures: new Map() };
  let figures = await readFigures(db, snapshot.id);
  if (!figures.length) {
    const rows = given?.rows ?? (await readSnapshotRows(db, snapshot.id));
    const catalog = given?.catalog ?? (await readStoredCatalog(db, snapshot.id));
    figures = headlineFigures(rows, catalog, snapshot.takenAt);
  }
  const lines = (await readLatestLines(db)) ?? linesOver(figures, new Date(snapshot.takenAt));
  return { figures: new Map(figures.map((f) => [strengthKey(f), f])), ...(lines ? { lines } : {}) };
}

// One model's tier: a router's from its cap, every other model's from its
// figure; a model with no figure has none.
export function strengthTier(strength: Strength, m: { provider: Provider; model: string; cap?: { input: number; output: number } }): Tier | undefined {
  if (m.cap) return modelTier({ figure: capFigure(m.cap) }, strength.lines);
  const f = strength.figures.get(strengthKey(m));
  return f ? modelTier({ free: f.free, figure: f.usd }, strength.lines) : undefined;
}

// One model's tier and figure, read on their own: one figure row and the
// lines, but all of readStrength where the current snapshot has no figures
// or no month has lines yet.
export async function readModelStrength(
  db: D1Database,
  m: { provider: Provider; model: string; cap?: { input: number; output: number } },
): Promise<{ tier?: Tier; figure?: StoredFigure }> {
  const snapshot = await currentSnapshot(db);
  if (!snapshot) return {};
  const [{ figure, any }, lines] = await Promise.all([readFigure(db, snapshot.id, m), readLatestLines(db)]);
  const strength: Strength = any && lines ? { figures: new Map(figure ? [[strengthKey(figure), figure]] : []), lines } : await readStrength(db, snapshot);
  const tier = strengthTier(strength, m);
  const f = strength.figures.get(strengthKey(m));
  return { ...(tier ? { tier } : {}), ...(f ? { figure: f } : {}) };
}

// The lines in force: the newest month's, or before any month has them, the
// ones the current snapshot's figures draw.
export async function readLinesInForce(db: D1Database): Promise<Lines | undefined> {
  return (await readLatestLines(db)) ?? (await readStrength(db, await currentSnapshot(db))).lines;
}
