// The Connect test's model, chosen from the user's own live model list by
// one stated rule (the owner, 2026-11-27: "not use a fixed hardcoded list of
// models but always query all models from the fucking provider"). The app
// holds no model ID of its own.
//
//   rankForTest(models, canCall) -> { paid, free }   the candidates, cheapest first
//   firstPick(ranked, credit, name) -> TestPick | undefined
//
// A candidate takes and gives text, has a list price, is not served by
// moderated endpoints only, has no retirement date, and is one the plug-in
// can call (the price table prices it). "Free" is $0 in and out. Cheapest is
// the lowest input plus output price per million tokens; a tie goes to the
// larger context, then to the ID in alphabetical order.
//
// The rule: the cheapest paid model, unless the provider says the account
// has no credit, when it is the cheapest free model. When the credit cannot
// be read, the cheapest paid model is tried, and a 402 (no credit) moves the
// test to the cheapest free one (check.ts runCheck). Each pick carries its
// reason, shown next to the result.

import type { AccountCredit, AccountModel } from "../proxy/plugin";

export interface TestPick {
  model: string;
  group: "paid" | "free";
  // Why this model, in plain words after "Tested on <model>: ".
  why: string;
}

// At most this many test calls for one check: a model that refuses the
// test request for its own reasons (busy, gone, its providers' data policy)
// hands it to the next cheapest of its group.
export const MAX_TEST_CALLS = 3;

const price = (m: AccountModel): number => (m.inputUsd ?? 0) + (m.outputUsd ?? 0);
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const isFreeModel = (m: AccountModel): boolean => m.inputUsd === 0 && m.outputUsd === 0;

export function rankForTest(models: readonly AccountModel[], canCall: (id: string) => boolean): { paid: AccountModel[]; free: AccountModel[] } {
  const eligible = models
    .filter((m) => m.text && !m.moderated && !m.expires && m.inputUsd !== undefined && m.outputUsd !== undefined && canCall(m.id))
    .sort((a, b) => price(a) - price(b) || (b.contextLength ?? 0) - (a.contextLength ?? 0) || byText(a.id, b.id));
  return { paid: eligible.filter((m) => !isFreeModel(m)), free: eligible.filter(isFreeModel) };
}

// The first model to test, and why. `name` is the provider's name ("OpenRouter").
export function firstPick(ranked: { paid: AccountModel[]; free: AccountModel[] }, credit: AccountCredit | undefined, name: string): TestPick | undefined {
  const [paid] = ranked.paid;
  const [free] = ranked.free;
  if (credit?.paid === "none") {
    return free ? { model: free.id, group: "free", why: `cheapest free model, because ${credit.why ?? `your ${name} account has no credit`}` } : undefined;
  }
  if (paid) return { model: paid.id, group: "paid", why: `cheapest paid model your ${name} account offers` };
  return free ? { model: free.id, group: "free", why: `cheapest free model, because your ${name} account offers no paid model the test can use` } : undefined;
}

// After a 402 on a paid pick: the cheapest free model.
export function freeAfterNoCredit(ranked: { free: AccountModel[] }, refused: string, name: string): TestPick | undefined {
  const [free] = ranked.free;
  return free ? { model: free.id, group: "free", why: `cheapest free model, because ${name} refused the cheapest paid model, ${refused}, for lack of credit (402)` } : undefined;
}

// After a refusal of the model's own: the next cheapest of the same group.
export function nextInGroup(ranked: { paid: AccountModel[]; free: AccountModel[] }, pick: TestPick, status: number): TestPick | undefined {
  const group = ranked[pick.group];
  const next = group[group.findIndex((m) => m.id === pick.model) + 1];
  return next ? { model: next.id, group: pick.group, why: `next cheapest ${pick.group} model, because ${pick.model} refused the test call (${status || "no reply"})` } : undefined;
}
