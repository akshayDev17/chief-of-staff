// Each user's one monthly OpenRouter budget (design-v3 1.8), and the value
// Models › Setup › Budgets suggests for it.
//
//   readBudget(db, userId, provider) -> Budget | undefined
//   setBudget(db, userId, provider, usd, how, now)
//   clearBudget(db, userId, provider)
//   readSuggestionBasis(db, userId) -> SuggestionBasis | undefined
//   suggest(basis, applicationsADay) -> Suggestion
//
// The budget is required: with none set, no model can be called except a
// model's test call and Test all models (proxy.ts, `no_budget`). There is no
// default, no daily budget and no per-model budget. The user sets it by
// accepting the suggestion or typing their own value, and may clear it, which
// stops model calls again until it is set.

import { readPriceCaps } from "../models/price-caps";
import { readUsableModels, type UsableModel } from "../models/usable";
import { currentSnapshot, readCurrentCatalog, readSnapshotRows } from "../prices/store";

export interface Budget {
  monthlyUsd: number;
  setHow: "accepted" | "typed";
  setAt: string;
}

export async function readBudget(db: D1Database, userId: string, provider: string): Promise<Budget | undefined> {
  const row = await db
    .prepare("SELECT monthly_usd, set_how, set_at FROM provider_budgets WHERE user_id = ? AND provider = ?")
    .bind(userId, provider)
    .first<{ monthly_usd: number; set_how: Budget["setHow"]; set_at: string }>();
  return row ? { monthlyUsd: row.monthly_usd, setHow: row.set_how, setAt: row.set_at } : undefined;
}

// A typed or accepted amount, in dollars, as a number the store accepts;
// undefined for anything else (empty, not a number, zero, negative).
export function parseBudget(text: string): number | undefined {
  const cleaned = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const usd = Number(cleaned);
  return isBudget(usd) ? usd : undefined;
}

const isBudget = (usd: number): boolean => Number.isFinite(usd) && usd > 0;

export async function setBudget(
  db: D1Database,
  userId: string,
  provider: string,
  monthlyUsd: number,
  setHow: Budget["setHow"],
  now: Date,
): Promise<void> {
  if (!isBudget(monthlyUsd)) throw new Error("a monthly budget is more than $0");
  await db
    .prepare(
      `INSERT INTO provider_budgets (user_id, provider, monthly_usd, set_how, set_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (user_id, provider) DO UPDATE SET monthly_usd = excluded.monthly_usd, set_how = excluded.set_how, set_at = excluded.set_at`,
    )
    .bind(userId, provider, monthlyUsd, setHow, now.toISOString())
    .run();
}

// The user's budget goes; model calls stop until one is set again.
export async function clearBudget(db: D1Database, userId: string, provider: string): Promise<void> {
  await db.prepare("DELETE FROM provider_budgets WHERE user_id = ? AND provider = ?").bind(userId, provider).run();
}

// Tokens per application, the design's own figures (design-v3 12.2,
// "Illustration only"): ten applications a day (seven Easy Apply, two
// single-page forms with one cover letter, one multi-page portal with a
// letter), with the 8 roles scored, 3 people approached and the small jobs
// (60 titles screened, 15 job pages read, 30 mails classified) that go with
// them, divided by ten. Input: 42,000 + 60,600 + 178,700 + 48,200 + 48,000 +
// 40,500 + 18,000 + 45,000 + 30,000 = 511,000 a day; output: 3,500 + 3,600 +
// 8,300 + 3,400 + 4,000 + 2,250 + 1,200 + 4,500 + 1,500 = 32,250 a day. Every
// token is costed as uncached input or output, so cache reads only lower the
// real figure. Replaced by the figures M12 and M13 measure.
export const TOKENS_PER_APPLICATION = { input: 51_100, output: 3_225 } as const;
export const DAYS_A_MONTH = 30;
export const DEFAULT_APPLICATIONS_A_DAY = 5;
export const MAX_APPLICATIONS_A_DAY = 100;

// The model a suggestion is worked from, at its price on OpenRouter's list
// (the current model list's price rows, src/prices/openrouter.ts, the same
// read the Providers page's table shows), or, for a router, at the user's
// own price cap on it (models/price-caps.ts), the most a call to it can cost.
export interface PricedModel {
  model: string;
  // As OpenRouter's list names it; the ID when the list has no name for it.
  name: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  free: boolean;
  // Priced at the user's price cap: a router.
  capped: boolean;
  // When OpenRouter's list was read for these prices, or the cap set (YYYY-MM-DD).
  checkedOn: string;
}

export interface SuggestionBasis {
  // Which models it was chosen among: the usable models the user's tasks use
  // (their saved choices, main and fallback), or, before any task uses one,
  // every usable model.
  from: "tasks" | "usable";
  model: PricedModel;
  // What one application costs at the design's tokens, in USD.
  perApplicationUsd: number;
}

export interface Suggestion extends SuggestionBasis {
  monthlyUsd: number; // whole dollars, rounded up, at least $1
  applicationsADay: number;
}

// One application at a model's prices, at the design's tokens.
export const applicationCost = (m: Pick<PricedModel, "inputUsdPerMTok" | "outputUsdPerMTok">): number =>
  (TOKENS_PER_APPLICATION.input * m.inputUsdPerMTok + TOKENS_PER_APPLICATION.output * m.outputUsdPerMTok) / 1_000_000;

// A month at `applicationsADay`, in whole dollars rounded up, at least $1.
// The page's script repeats this exact sum as the volume is typed
// (budgets-page.ts), so the figure it shows is the one Set saves.
export const monthlyFor = (perApplicationUsd: number, applicationsADay: number): number =>
  Math.max(1, Math.ceil(perApplicationUsd * applicationsADay * DAYS_A_MONTH));

export const suggest = (basis: SuggestionBasis, applicationsADay: number): Suggestion => ({
  ...basis,
  applicationsADay,
  monthlyUsd: monthlyFor(basis.perApplicationUsd, applicationsADay),
});

// The models the suggestion may be worked from: the user's usable models on
// OpenRouter (models/usable.ts readUsableModels, the one rule for what a task
// can use) that their tasks' saved choices use, main or fallback; else every
// usable model. Empty before any model has passed its test.
export async function suggestionCandidates(db: D1Database, userId: string): Promise<{ from: SuggestionBasis["from"]; models: UsableModel[] }> {
  const usable = (await readUsableModels(db, userId)).filter((m) => m.provider === "openrouter");
  const { results: routes } = await db
    .prepare("SELECT main_provider, main_model, fallback_provider, fallback_model FROM task_routes WHERE user_id = ?")
    .bind(userId)
    .all<{ main_provider: string; main_model: string; fallback_provider: string | null; fallback_model: string | null }>();
  const used = new Set(
    routes.flatMap((r) => [
      r.main_provider === "openrouter" ? r.main_model : undefined,
      r.fallback_provider === "openrouter" ? (r.fallback_model ?? undefined) : undefined,
    ]).filter((m): m is string => Boolean(m)),
  );
  const inUse = usable.filter((m) => used.has(m.model));
  return inUse.length ? { from: "tasks", models: inUse } : { from: "usable", models: usable };
}

// The suggestion's basis: the dearest of the candidates for one application,
// ties by name. Undefined when there is no candidate, or none has a price.
// Prices come from one read of the current price rows; a router's from the
// user's cap.
export async function readSuggestionBasis(db: D1Database, userId: string): Promise<SuggestionBasis | undefined> {
  const { from, models } = await suggestionCandidates(db, userId);
  if (!models.length) return undefined;
  const snapshot = await currentSnapshot(db);
  const [rows, catalog, caps] = await Promise.all([
    snapshot ? readSnapshotRows(db, snapshot.id) : Promise.resolve([]),
    readCurrentCatalog(db),
    readPriceCaps(db, userId, "openrouter"),
  ]);
  const listed = new Map((catalog?.models ?? []).map((m) => [m.id, m]));
  const standard = (m: UsableModel, kind: "input" | "output") =>
    rows
      .filter((r) => r.provider === m.provider && r.model === m.model && r.tokenKind === kind && !r.longPrompt && !r.batch && (r.region === m.location || r.deployment === m.location))
      .sort((a, b) => b.usdPerMTok - a.usdPerMTok)[0];
  let best: SuggestionBasis | undefined;
  for (const m of models) {
    const entry = listed.get(m.model);
    const cap = entry?.router ? caps.get(m.model) : undefined;
    const input = cap ? undefined : standard(m, "input");
    const output = cap ? undefined : standard(m, "output");
    if (!cap && (!input || !output)) continue;
    const priced: PricedModel = {
      model: m.model,
      name: entry?.name ?? m.model,
      inputUsdPerMTok: cap ? cap.input : input!.usdPerMTok,
      outputUsdPerMTok: cap ? cap.output : output!.usdPerMTok,
      free: entry?.free === true,
      capped: Boolean(cap),
      checkedOn: cap ? (cap.setAt ?? "").slice(0, 10) : input!.dateRead < output!.dateRead ? input!.dateRead : output!.dateRead,
    };
    const perApplicationUsd = applicationCost(priced);
    if (!best || perApplicationUsd > best.perApplicationUsd || (perApplicationUsd === best.perApplicationUsd && priced.name.localeCompare(best.model.name) < 0)) {
      best = { from, model: priced, perApplicationUsd };
    }
  }
  return best;
}
