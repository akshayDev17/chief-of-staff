// Ready: the models a user's tasks can use, with no test call (the owner,
// 2026-11-28: "once i have added enough credits, why shouldn't in the test
// models table, all those models that can be called within the added credits
// become automatically "works"?"). Worked out from the live lists on every
// read, so credit added on the provider makes its paid models Ready on the
// next visit, with no click.
//
//   rowState(row, credit) -> RowState              the one rule: the strip, its filters, the dropdowns
//   readTable(db, plugins, userId, provider) -> Table   every row of the model list, with its state
//   readReadyModels(db, plugins, userId) -> TableRow[]  the Ready rows at every provider a plug-in serves
//   readAccountLive(db, plugin, userId) -> AccountInfo | undefined   the account line's live read, its credit kept
//   recordUse(db, plugins, userId, outcome, now)   what a task's own call showed about its model
//
// A model is Ready when the model list has it (models/test-model.ts
// listOffer: OpenRouter lists it with tool use among its parameters; one
// without tool use never reaches the list), nothing blocks it (the account's
// own list includes it, a router has the user's price cap, it has a price,
// the app can call it), and it is free or the account has credit left. No
// call decides it, and the label is Ready, never Works: no call was made. A
// failed call, a task's own or a Test, only marks its row (Failed when used,
// or when tested); the model stays Ready and choosable.
//
// The credit figure is the account line's (OpenRouter's GET /api/v1/key, read
// live with the user's key): credit bought at all (`is_free_tier` false), and
// the key's own limit not used up where it has one. The app cannot read the
// balance itself (that needs a management key), so an account whose bought
// credit ran out reads as having credit: its paid model's call is refused
// with no credit and its task falls to the fallback, with nothing kept, so
// the credit figure alone says Needs credit or Ready. The figure is
// kept on the connection (has_credit) so every reader takes the same one;
// a key with no figure yet (just connected) is read live once, by whichever
// reader comes first. A provider whose plug-in cannot read it counts as
// having credit; an account that cannot be read counts as having none.

import { readConnection, readHasCredit, saveHasCredit } from "../proxy/connections";
import type { AccountInfo, PlainReason, PluginRegistry, ProviderPlugin } from "../proxy/plugin";
import type { ProxyOutcome } from "../proxy/proxy";
import { PROVIDERS, type Provider } from "../prices/types";
import { latestTestWrite, readLatestTests, type LatestTest } from "./latest-tests";
import { blockKind, listOffer, testRecord, type OfferRow, type Refused } from "./test-model";

// A row's place in the strip: Ready, Needs credit, or Needs a step (the settings leave it out, a router needs its cap, it has no
// price, the app can't call it). Every row is in exactly one, so the strip's
// cells add up to the list's count.
export type RowState = "ready" | "credit" | "step";

// The one rule. `credit`: the account has credit left.
export function rowState(row: OfferRow, credit: boolean): RowState {
  if (blockKind(row)) return "step";
  if (!row.free && !credit) return "credit";
  return "ready";
}

export interface TableRow extends OfferRow {
  provider: Provider;
  state: RowState;
  // Its latest real call on the current key, where it has one.
  latest?: LatestTest;
}

export interface Table {
  rows: TableRow[];
  // The account has credit left, by its last live read.
  credit: boolean;
}

// Has the account credit left, by the account line's figures.
export const hasCreditLeft = (a: AccountInfo): boolean => !a.freeTier && (a.limitRemainingUsd === undefined || a.limitRemainingUsd > 0);

async function readCredit(db: D1Database, plugin: ProviderPlugin, userId: string): Promise<boolean> {
  if (!plugin.connect.readAccount) return true;
  const kept = await readHasCredit(db, userId, plugin.provider);
  if (kept !== undefined) return kept;
  const account = await readAccountLive(db, plugin, userId);
  return account ? hasCreditLeft(account) : false;
}

// The account behind the user's key, read live, server side, with the key
// from the vault; its credit figure is kept for the rule. Undefined when it
// could not be read, which keeps the last figure.
export async function readAccountLive(db: D1Database, plugin: ProviderPlugin, userId: string): Promise<AccountInfo | undefined> {
  if (!plugin.connect.readAccount) return undefined;
  const connection = await readConnection(db, userId, plugin.provider);
  if (!connection) return undefined;
  let account: AccountInfo | undefined;
  try {
    account = await plugin.connect.readAccount(await plugin.mintCredential(connection, { userId }));
  } catch {
    return undefined;
  }
  if (account) await saveHasCredit(db, userId, plugin.provider, hasCreditLeft(account));
  return account;
}

// Every row of the model list at `provider`, each with its state. Scoped to the user.
export async function readTable(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider): Promise<Table> {
  const plugin = plugins[provider];
  if (!plugin) return { rows: [], credit: false };
  const [offers, latest, credit] = await Promise.all([listOffer(db, plugins, userId, provider), readLatestTests(db, userId, provider), readCredit(db, plugin, userId)]);
  const rows = offers.map((r): TableRow => {
    const l = latest.get(r.model);
    const current = l && !l.earlierKey ? l : undefined;
    return { ...r, provider, state: rowState(r, credit), ...(current ? { latest: current } : {}) };
  });
  return { rows, credit };
}

// The table's rows at every provider a plug-in serves, in provider order.
export async function readAllRows(db: D1Database, plugins: PluginRegistry, userId: string): Promise<TableRow[]> {
  const tables = await Promise.all(PROVIDERS.filter((p) => plugins[p]).map((p) => readTable(db, plugins, userId, p)));
  return tables.flatMap((t) => t.rows);
}

export async function readReadyModels(db: D1Database, plugins: PluginRegistry, userId: string): Promise<TableRow[]> {
  return (await readAllRows(db, plugins, userId)).filter((r) => r.state === "ready");
}

// The refusals a task's call can meet that say nothing about its model: the
// provider busy or not answering, the key gone, no credit (the credit figure
// says that). Every other refusal marks the model Failed when used.
const SAYS_NOTHING = new Set<PlainReason>(["busy", "no_reply", "not_set_up", "no_credits"]);

// Whether a refusal for `reason` marks the model Failed when used.
export const marksModel = (reason: PlainReason): boolean => !SAYS_NOTHING.has(reason);

// What a task's own call showed about its model: a refusal marks it Failed
// when used, with the plain reason; an answer takes back an earlier failure.
// A refusal made before any call (no budget, not connected) marks nothing.
export async function recordUse(db: D1Database, plugins: PluginRegistry, userId: string, outcome: ProxyOutcome, now: Date): Promise<void> {
  const { provider, model } = outcome;
  if (outcome.kind === "answered") {
    await db
      .prepare(
        `UPDATE model_latest_tests SET state = 'passed', result = ?, tested_at = ?
         WHERE user_id = ? AND provider = ? AND model = ? AND state = 'failed' AND tested_at <= ?`,
      )
      .bind(JSON.stringify({ text: "Worked when used.", used: true }), now.toISOString(), userId, provider, model, now.toISOString())
      .run();
    return;
  }
  const plugin = plugins[provider];
  if (outcome.kind !== "provider_error" || !outcome.failure || !plugin) return;
  const { failure } = outcome;
  const plain = plugin.connect.classify(failure, await readConnection(db, userId, provider));
  if (!marksModel(plain.reason)) return;
  const refused: Refused = {
    kind: "refused",
    model,
    reason: plain.reason,
    reply: { status: failure.status, errorName: failure.errorName, message: failure.message },
    fix: plain.fix,
    links: plain.links,
  };
  await latestTestWrite(db, userId, provider, model, "failed", { ...testRecord(refused, plugin), used: true }, now).run();
}
