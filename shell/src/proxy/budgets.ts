// Each user's monthly budget per provider (design-v3 1.8), and the value each
// budget field suggests.
//
// The budget is required: a provider with none set cannot be called. There is
// no default, no daily budget and no per-model budget. The user sets it by
// accepting the suggestion or typing their own value.

import { lookupPrice } from "../prices/lookup";
import type { Provider } from "../prices/types";

export interface Budget {
  monthlyUsd: number;
  setHow: "accepted" | "typed";
  setAt: string;
}

// The highest budget the field accepts, to catch a mistyped extra zero or two.
export const MAX_MONTHLY_USD = 10_000;

export async function readBudget(db: D1Database, userId: string, provider: string): Promise<Budget | undefined> {
  const row = await db
    .prepare("SELECT monthly_usd, set_how, set_at FROM provider_budgets WHERE user_id = ? AND provider = ?")
    .bind(userId, provider)
    .first<{ monthly_usd: number; set_how: Budget["setHow"]; set_at: string }>();
  return row ? { monthlyUsd: row.monthly_usd, setHow: row.set_how, setAt: row.set_at } : undefined;
}

// A typed or accepted amount, in dollars, as a number the store accepts;
// undefined for anything else (empty, not a number, zero, negative, too big).
export function parseBudget(text: string): number | undefined {
  const cleaned = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const usd = Number(cleaned);
  return usd > 0 && usd <= MAX_MONTHLY_USD ? usd : undefined;
}

export async function setBudget(
  db: D1Database,
  userId: string,
  provider: string,
  monthlyUsd: number,
  setHow: Budget["setHow"],
  now: Date,
): Promise<void> {
  if (!(monthlyUsd > 0 && monthlyUsd <= MAX_MONTHLY_USD)) throw new Error(`a monthly budget is more than $0 and at most $${MAX_MONTHLY_USD}`);
  await db
    .prepare(
      `INSERT INTO provider_budgets (user_id, provider, monthly_usd, set_how, set_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (user_id, provider) DO UPDATE SET monthly_usd = excluded.monthly_usd, set_how = excluded.set_how, set_at = excluded.set_at`,
    )
    .bind(userId, provider, monthlyUsd, setHow, now.toISOString())
    .run();
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

export interface PickedModel {
  provider: Provider;
  model: string;
  location: string;
}

export interface Suggestion {
  monthlyUsd: number; // whole dollars, rounded up
  model: string; // the picked model it is worked from
  applicationsADay: number;
  checkedOn: string; // the older date read of the two prices used
}

// The suggestion for one provider: if that provider carried every task at
// the given volume, on the dearest model the user picked there. Undefined
// when no picked model there has both an input and an output price.
export async function suggestBudget(db: D1Database, picked: PickedModel[], applicationsADay: number): Promise<Suggestion | undefined> {
  let best: Suggestion | undefined;
  for (const m of picked) {
    const [input, output] = await Promise.all([
      lookupPrice(db, { ...m, tokenKind: "input" }),
      lookupPrice(db, { ...m, tokenKind: "output" }),
    ]);
    if (!input || !output) continue;
    const perApplication =
      (TOKENS_PER_APPLICATION.input * input.usdPerMTok + TOKENS_PER_APPLICATION.output * output.usdPerMTok) / 1_000_000;
    const monthlyUsd = Math.max(1, Math.ceil(perApplication * applicationsADay * DAYS_A_MONTH));
    if (!best || monthlyUsd > best.monthlyUsd) {
      best = { monthlyUsd, model: m.model, applicationsADay, checkedOn: input.dateRead < output.dateRead ? input.dateRead : output.dateRead };
    }
  }
  return best;
}

// The models this user picked at one provider (written by T17).
export async function pickedModels(db: D1Database, userId: string, provider: Provider): Promise<PickedModel[]> {
  const { results } = await db
    .prepare("SELECT provider, model, location FROM user_models WHERE user_id = ? AND provider = ? ORDER BY model")
    .bind(userId, provider)
    .all<PickedModel>();
  return results;
}
