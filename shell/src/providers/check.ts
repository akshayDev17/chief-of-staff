// The Connect check (design-v3 1.5, T16): Connect through the provider's own
// consent page, the test call that runs by itself once the provider has
// issued the app its key, its plain result, and its retries.
//
//   connectProvider(...)  "Connect <Provider>": the provider's consent page to open
//   finishConsent(...)    back from that page: the key into the vault, the record, then the check
//   runCheck(...)         make the test call, record the result
//   disconnectProvider()  the key, the record and the check go
//   runDueChecks(...)     the cron, every minute: the checks whose next try is due
//
// The test call's model is never the app's own: each check reads the
// user's live model list with their key (and saves it as the account's list),
// reads the account's credit where the provider reports it, and picks the
// model by the rule in test-model.ts, the cheapest paid model or, with no
// credit, the cheapest free one. The result names the model and why. When the
// list cannot be read, the check fails with that plain reason: there is no
// built-in list to fall back to.
//
// A test call is a real call to the user's own provider account, sent
// through the proxy (`sendTestCall`), which prices it, writes its ledger row
// (task `test_call`) and records a removed grant, as for every call. It needs
// the model's list price, as every call does: while the price table has none
// (before the first refresh) it waits and is tried again every 15 minutes. It
// runs before any budget is set (budgets come after providers on the setup
// checklist), and waits when one is set and spent. A connection that had
// passed and then loses its key on the provider's side is recorded as
// revoked, for T49's urgent alert.

import { AppNotConfigured } from "../app-config";
import type { Provider } from "../prices/types";
import { readBudget } from "../proxy/budgets";
import { connectedProviders, deleteConnection, readConnection, writeConnection } from "../proxy/connections";
import { nextMonthStart } from "../proxy/ledger";
import { ConnectProblem, ProviderRefusal, type AccountCredit, type AccountModel, type ConnectionFields, type Failure, type Link, type PlainReason, type PluginRegistry, type ProviderPlugin, type Usage } from "../proxy/plugin";
import { PROVIDER_NAMES, sendTestCall } from "../proxy/proxy";
import { deleteAccountList, saveAccountList } from "../models/account-list";
import type { SecretStore } from "./secrets";
import { firstPick, freeAfterNoCredit, MAX_TEST_CALLS, nextInGroup, rankForTest, type TestPick } from "./test-model";

export const RETRY_MINUTES = 15;

// The key's credit limit prefilled on the provider's consent page when the
// user has no monthly budget at the provider yet; they can change it there.
export const DEFAULT_CREDIT_LIMIT_USD = 10;

export type CheckState = "checking" | "passed" | "failed" | "revoked";

// What waited instead of a test call.
export type Waiting = "budget_spent" | "no_price";

// Why no test model could be chosen: the account's list could not be read,
// or it offers no model the test can use.
export type NoTestModel = "no_model_list" | "no_test_model";

// The test call's three lines, for the user who made it only.
export interface CheckResult {
  at: string;
  verdict: "passed" | "failed";
  reason?: PlainReason | Waiting | NoTestModel;
  // The model the test call went to, chosen from the account's live list;
  // absent when none could be chosen.
  model?: string;
  // Why that model, by the stated rule ("cheapest free model, because your
  // OpenRouter account has no credit").
  why?: string;
  // The account's free-model requests today, where the provider reports them.
  freeDaily?: AccountCredit["freeDaily"];
  location: string;
  // The provider's own answer: status, error name and message verbatim, or
  // its reply text on a pass. Absent when nothing reached the provider.
  reply?: { status: number; errorName?: string; message?: string; text?: string };
  // Why nothing reached the provider, in the app's words.
  note?: string;
  fix?: string;
  links?: Link[];
  usage?: Usage;
  costUsd?: number;
}

export interface Check {
  provider: Provider;
  state: CheckState;
  result?: CheckResult;
  checkedAt?: string;
  nextTryAt?: string;
  passedAt?: string;
  revokedAt?: string;
  // While the user is on the provider's consent page: the state value it
  // must send back.
  consentState?: string;
}

interface CheckRecord {
  provider: Provider;
  state: CheckState;
  result: string | null;
  checked_at: string | null;
  next_try_at: string | null;
  passed_at: string | null;
  revoked_at: string | null;
  consent_state: string | null;
}

const toCheck = (r: CheckRecord): Check => ({
  provider: r.provider,
  state: r.state,
  result: r.result ? (JSON.parse(r.result) as CheckResult) : undefined,
  checkedAt: r.checked_at ?? undefined,
  nextTryAt: r.next_try_at ?? undefined,
  passedAt: r.passed_at ?? undefined,
  revokedAt: r.revoked_at ?? undefined,
  consentState: r.consent_state ?? undefined,
});

const CHECK_COLUMNS = "provider, state, result, checked_at, next_try_at, passed_at, revoked_at, consent_state";

export async function readCheck(db: D1Database, userId: string, provider: string): Promise<Check | undefined> {
  const r = await db.prepare(`SELECT ${CHECK_COLUMNS} FROM provider_checks WHERE user_id = ? AND provider = ?`).bind(userId, provider).first<CheckRecord>();
  return r ? toCheck(r) : undefined;
}

async function saveCheck(db: D1Database, userId: string, c: Check): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provider_checks (user_id, provider, state, result, checked_at, next_try_at, passed_at, revoked_at, consent_state)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (user_id, provider) DO UPDATE SET state = excluded.state, result = excluded.result, checked_at = excluded.checked_at,
         next_try_at = excluded.next_try_at, passed_at = excluded.passed_at, revoked_at = excluded.revoked_at,
         consent_state = excluded.consent_state`,
    )
    .bind(
      userId, c.provider, c.state, c.result ? JSON.stringify(c.result) : null, c.checkedAt ?? null, c.nextTryAt ?? null,
      c.passedAt ?? null, c.revokedAt ?? null, c.consentState ?? null,
    )
    .run();
}

const minutesAfter = (now: Date, minutes: number): string => new Date(now.getTime() + minutes * 60_000).toISOString();

// The plain sentence for a reason, the first of the result's three lines.
// Shared with the model list (models/add.ts) and Test all models.
export function reasonText(reason: PlainReason | Waiting | NoTestModel | undefined, plugin: ProviderPlugin, model: string | undefined): string {
  const { guide } = plugin.connect;
  switch (reason) {
    case "not_set_up":
      return "The connection isn't set up yet, or was removed.";
    case "no_credits":
      return `Needs credit on ${guide.name}: your account or this key has none left for this paid model.`;
    case "no_such_model":
      return "That model ID doesn't exist here.";
    case "no_permission":
      return `${guide.short} refused this request for your account.`;
    case "busy":
      return "Busy or out of quota, not a setup fault.";
    case "app_not_configured":
      return `The app's own side of ${guide.name} isn't set up yet.`;
    case "no_reply":
      return `No reply from ${guide.short}.`;
    case "budget_spent":
      return `This month's budget for ${guide.name} is spent, so the test call waits until the 1st.`;
    case "no_price":
      return `${model ?? "The test model"} has no list price at ${guide.name} yet, so the test call waits for the price table.`;
    case "no_model_list":
      return `${guide.short} did not give your account's model list, so no test model can be chosen from it.`;
    case "no_test_model":
      return `Your ${guide.short} account's model list has no model the test call can use.`;
    default:
      return `${guide.short} refused the test call.`;
  }
}

// The plain verdict, in the app's words: the first of the three lines.
export function verdictText(result: CheckResult, plugin: ProviderPlugin): string {
  return result.verdict === "passed" ? "Test call passed" : reasonText(result.reason, plugin, result.model);
}

// The account's live model list, read with the user's own key, or why it
// could not be read.
type ListRead = { credential: unknown; models: AccountModel[] } | { failure: Failure } | { missing: string[] } | { unread: Failure | undefined };

async function readList(plugin: ProviderPlugin, connection: ConnectionFields, userId: string): Promise<ListRead> {
  let credential: unknown;
  try {
    credential = await plugin.mintCredential(connection, { userId });
  } catch (error) {
    if (error instanceof AppNotConfigured) return { missing: error.missing };
    const r = error instanceof ProviderRefusal ? error.refusal : undefined;
    return { failure: { step: "credential", exchange: r?.step, status: r?.status ?? 0, errorName: r?.errorName ?? "error", message: r?.message ?? "" } };
  }
  try {
    return { credential, models: await plugin.connect.readAccountModels(credential) };
  } catch (error) {
    const r = error instanceof ProviderRefusal ? error.refusal : undefined;
    const failure: Failure | undefined = r && { step: "call", status: r.status, errorName: r.errorName, message: r.message };
    // A key the provider no longer accepts: removed, as on a test call.
    if (failure?.status === 401) return { failure };
    return { unread: failure };
  }
}

// A refusal that is the model's own (busy, gone, its providers' data
// policy), so the next model of the same group may accept the test.
const MODEL_OWN: ReadonlySet<PlainReason> = new Set<PlainReason>(["no_such_model", "busy", "no_reply", "refused", "no_permission"]);

// Makes the test call through the proxy on a model chosen from the user's
// live model list by test-model.ts's rule (never a model the user picked,
// never one the app names itself), then records the result.
export async function runCheck(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider, now: Date): Promise<Check | undefined> {
  const plugin = plugins[provider];
  const connection = await readConnection(db, userId, provider);
  const before = await readCheck(db, userId, provider);
  if (!plugin || !connection) return before;
  const { name, short } = plugin.connect.guide;
  const base: Check = { ...(before ?? { provider, state: "checking" }), provider, checkedAt: now.toISOString(), consentState: before?.consentState };
  const location = "global";
  const at = now.toISOString();

  const finish = async (result: CheckResult): Promise<Check> => {
    let c: Check;
    if (result.verdict === "passed") {
      c = { ...base, state: "passed", result, passedAt: now.toISOString(), revokedAt: undefined, nextTryAt: undefined };
    } else if (result.reason === "not_set_up" && before?.passedAt) {
      // It had passed: the key was deleted or disabled on the provider's side.
      c = { ...base, state: "revoked", result, revokedAt: before.revokedAt ?? now.toISOString(), nextTryAt: undefined };
    } else {
      c = { ...base, state: before?.state === "revoked" ? "revoked" : "failed", result, nextTryAt: undefined };
    }
    await saveCheck(db, userId, c);
    return c;
  };
  const wait = async (head: Omit<CheckResult, "verdict">, reason: Waiting, nextTryAt: string): Promise<Check> => {
    const result: CheckResult = { ...head, verdict: "failed", reason };
    const c: Check = { ...base, state: before?.state === "passed" || before?.state === "revoked" ? before.state : "failed", result, nextTryAt };
    await saveCheck(db, userId, c);
    return c;
  };
  const refusal = (head: Omit<CheckResult, "verdict">, failure: Failure): CheckResult => {
    const plain = plugin.connect.classify(failure, connection);
    return {
      ...head,
      verdict: "failed",
      reason: plain.reason,
      reply: failure.step === "call" ? { status: failure.status, errorName: failure.errorName, message: failure.message } : undefined,
      note: failure.step === "credential" ? `The app holds no ${short} key for you.` : undefined,
      fix: plain.fix,
      links: plain.links,
    };
  };

  // The account's own list, live: the only place a test model comes from.
  const read = await readList(plugin, connection, userId);
  if ("missing" in read) return finish({ at, location, verdict: "failed", reason: "app_not_configured", note: `Admin's one-time setup is missing ${read.missing.join(", ")}.` });
  if ("failure" in read) return finish(refusal({ at, location }, read.failure));
  if ("unread" in read) {
    const r = read.unread;
    return finish({
      at,
      location,
      verdict: "failed",
      reason: "no_model_list",
      ...(r ? { reply: { status: r.status, errorName: r.errorName, message: r.message } } : { note: `${short} did not answer.` }),
      fix: `Try again in a minute. The test call only ever uses a model from your own ${short} list, so it waits for that list.`,
    });
  }
  await saveAccountList(db, userId, provider, read.models.map((m) => m.id), now);
  const credit = await plugin.connect.readAccountCredit?.(read.credential);
  const freeDaily = credit?.freeDaily ? { freeDaily: credit.freeDaily } : {};
  const ranked = rankForTest(read.models, plugin.connect.canCall);
  const first = firstPick(ranked, credit, name);
  if (!first) {
    // The list names models the test could use, but the price table has
    // none of them yet: it fills at the next refresh.
    if (firstPick(rankForTest(read.models, () => true), credit, name)) return wait({ at, location, ...freeDaily }, "no_price", minutesAfter(now, RETRY_MINUTES));
    const terms = plugin.connect.freeModelTerms;
    return finish({
      at,
      location,
      ...freeDaily,
      verdict: "failed",
      reason: "no_test_model",
      fix:
        credit?.paid === "none"
          ? `${credit.why ? `${credit.why[0]!.toUpperCase()}${credit.why.slice(1)}` : `Your ${name} account has no credit`}, and your list offers no free model the test can use. Add credit on ${name}, or allow free models in your ${short} settings.${terms ? ` ${terms.text}` : ""}`
          : `It needs a text model with a price, served by more than moderated endpoints and not being retired.`,
      links: terms?.links ?? [],
    });
  }

  let pick: TestPick = first;
  for (let calls = 1; ; calls++) {
    const head = { at, model: pick.model, why: pick.why, location, ...freeDaily };
    const outcome = await sendTestCall(db, plugins, userId, { provider, model: pick.model, location, request: plugin.connect.testRequest(pick.model) }, () => now);
    if (outcome.kind === "answered") {
      return finish({ ...head, verdict: "passed", reply: { status: outcome.status, text: plugin.connect.replyText(outcome.body) }, usage: outcome.usage, costUsd: outcome.costUsd });
    }
    if (outcome.kind === "refused" && outcome.reason === "budget_spent") return wait(head, "budget_spent", nextMonthStart(now).toISOString());
    // No price, or the model list not read yet: the price table fills at the
    // next refresh.
    if (outcome.kind === "refused" && (outcome.reason === "no_price" || outcome.reason === "not_callable")) return wait(head, "no_price", minutesAfter(now, RETRY_MINUTES));
    if (outcome.failure) {
      const { failure } = outcome;
      const next: TestPick | undefined =
        failure.step !== "call" || calls >= MAX_TEST_CALLS
          ? undefined
          : failure.status === 402
            ? pick.group === "paid"
              ? freeAfterNoCredit(ranked, pick.model, name)
              : undefined
            : MODEL_OWN.has(plugin.connect.classify(failure, connection).reason)
              ? nextInGroup(ranked, pick, failure.status)
              : undefined;
      if (next) {
        pick = next;
        continue;
      }
      return finish(refusal(head, failure));
    }
    if (outcome.kind === "refused" && outcome.missing) return finish({ ...head, verdict: "failed", reason: "app_not_configured", note: `Admin's one-time setup is missing ${outcome.missing.join(", ")}.` });
    if (outcome.kind === "provider_error") return finish({ ...head, verdict: "failed", reason: "no_reply", note: `${short} did not answer the test call.` });
    // The connection went while the check ran.
    return before;
  }
}

export type ConnectOutcome = { problem: string } | { open: string } | { check?: Check };

const randomState = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

const notSetUp = (plugin: ProviderPlugin, missing: string[]): { problem: string } => ({
  problem: `The app's own side of ${plugin.connect.guide.name} isn't set up yet: Admin's one-time setup is missing ${missing.join(", ")}.`,
});

// The address the provider's consent page sends the user back to.
export const callbackUrl = (appOrigin: string, providersPath: string, provider: Provider): string => `${appOrigin}${providersPath}/${provider}/consented`;

// "Connect <Provider>": the provider's consent page, with a fresh state value
// and PKCE verifier (kept in the user's vault until the page sends them
// back). A connection already stored keeps working until a new one replaces
// it.
export async function connectProvider(
  db: D1Database,
  plugins: PluginRegistry,
  secrets: SecretStore,
  input: { userId: string; provider: Provider; callbackUrl: string | undefined; now: Date },
): Promise<ConnectOutcome> {
  const plugin = plugins[input.provider];
  if (!plugin) return { problem: "That provider is not offered." };
  if (!input.callbackUrl) return notSetUp(plugin, ["APP_ORIGIN"]);
  const consentState = randomState();
  const creditLimitUsd = (await readBudget(db, input.userId, input.provider))?.monthlyUsd ?? DEFAULT_CREDIT_LIMIT_USD;
  const start = await plugin.connect.start({ callbackUrl: input.callbackUrl, consentState, creditLimitUsd });
  try {
    await secrets.put(input.userId, input.provider, "verifier", start.verifier, input.now);
  } catch (error) {
    if (error instanceof AppNotConfigured) return notSetUp(plugin, error.missing);
    throw error;
  }
  const before = await readCheck(db, input.userId, input.provider);
  await saveCheck(db, input.userId, { ...(before ?? { provider: input.provider, state: "checking" }), consentState });
  return { open: start.open };
}

// Back from the provider's consent page, which must return the state value
// this user's Connect sent. The state is spent before anything else is done
// with the answer, so it works once, even when two answers race. Then the
// code is traded for the key, which goes into the vault, and the check runs.
export async function finishConsent(
  db: D1Database,
  plugins: PluginRegistry,
  secrets: SecretStore,
  input: { userId: string; provider: Provider; returned: URLSearchParams; now: Date },
): Promise<ConnectOutcome> {
  const plugin = plugins[input.provider];
  const check = await readCheck(db, input.userId, input.provider);
  const name = plugin?.connect.guide.name ?? "the provider";
  const notThis = { problem: `That answer from ${name} was not for this Connect. Tap Connect ${name} again.` };
  const state = input.returned.get("state");
  if (!plugin || !check?.consentState || !state || state !== check.consentState) return notThis;
  const spent = await db
    .prepare("UPDATE provider_checks SET consent_state = NULL WHERE user_id = ? AND provider = ? AND consent_state = ?")
    .bind(input.userId, input.provider, state)
    .run();
  if (spent.meta.changes !== 1) return notThis;
  let issued: { fields: Record<string, string>; secret: string };
  try {
    const verifier = await secrets.read(input.userId, input.provider, "verifier");
    await secrets.remove(input.userId, input.provider, "verifier");
    if (!verifier) return notThis;
    issued = await plugin.connect.finish(verifier, input.returned);
    await secrets.put(input.userId, input.provider, "key", issued.secret, input.now);
  } catch (error) {
    if (error instanceof ConnectProblem) return { problem: error.message };
    if (error instanceof AppNotConfigured) return notSetUp(plugin, error.missing);
    throw error;
  }
  await writeConnection(db, input.userId, plugin, issued.fields, input.now);
  // A new connection: it has not passed yet, whatever an earlier one did. Its
  // check runs here; the cron tries it only if this one never finishes.
  await saveCheck(db, input.userId, { provider: input.provider, state: "checking", nextTryAt: minutesAfter(input.now, RETRY_MINUTES) });
  // The check reads the account's own model list with the new key, saves
  // it, and tests on a model from it.
  return { check: await runCheck(db, plugins, input.userId, input.provider, input.now) };
}

// Saving a budget: a test call waiting for this provider's spent budget
// runs again at once, so a raised budget lets it through without waiting for
// the 1st (one still spent waits as before, with no call made).
export async function rerunBudgetWait(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider, now: Date): Promise<void> {
  const check = await readCheck(db, userId, provider);
  if (check?.result?.reason === "budget_spent") await runCheck(db, plugins, userId, provider, now);
}

// Disconnect: the key leaves the vault, and the record and its check go; the
// provider's models stop answering for this user at once. The key itself
// stays valid on the provider's side until the user deletes it there (the
// guide says how): OpenRouter lets no app delete a key it was given.
export async function disconnectProvider(db: D1Database, secrets: SecretStore, userId: string, provider: Provider): Promise<void> {
  await secrets.remove(userId, provider, "key");
  await secrets.remove(userId, provider, "verifier");
  await deleteConnection(db, userId, provider);
  await deleteAccountList(db, userId, provider);
  await db.prepare("DELETE FROM provider_checks WHERE user_id = ? AND provider = ?").bind(userId, provider).run();
}

// "Ask Admin for help": the item's name and the plain reason, never the
// provider's reply.
export async function askAdminForHelp(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider, now: Date): Promise<boolean> {
  const plugin = plugins[provider];
  const check = await readCheck(db, userId, provider);
  if (!plugin || !check?.result || check.result.verdict === "passed") return false;
  await db
    .prepare("INSERT INTO help_requests (user_id, item, reason, at) VALUES (?, ?, ?, ?)")
    .bind(userId, `Connect ${plugin.connect.guide.name}`, verdictText(check.result, plugin), now.toISOString())
    .run();
  return true;
}

// The cron: every check whose next try is due, oldest first, a few a minute.
// Only checks of providers a plug-in serves: rows left from a removed
// provider (Bedrock, Vertex AI, Foundry) are never picked, so they cannot
// crowd out the others. Each is claimed first, its next try moved on, so a
// tick that overlaps the one before never makes the same test call twice.
export async function runDueChecks(db: D1Database, plugins: PluginRegistry, now: Date, limit = 25): Promise<number> {
  const served = Object.keys(plugins);
  if (!served.length) return 0;
  const { results } = await db
    .prepare(
      `SELECT user_id, provider, next_try_at FROM provider_checks WHERE next_try_at IS NOT NULL AND next_try_at <= ?
         AND provider IN (SELECT value FROM json_each(?)) ORDER BY next_try_at LIMIT ?`,
    )
    .bind(now.toISOString(), JSON.stringify(served), limit)
    .all<{ user_id: string; provider: Provider; next_try_at: string }>();
  for (const { user_id, provider, next_try_at } of results) {
    const claimed = await db
      .prepare("UPDATE provider_checks SET next_try_at = ? WHERE user_id = ? AND provider = ? AND next_try_at = ?")
      .bind(minutesAfter(now, RETRY_MINUTES), user_id, provider, next_try_at)
      .run();
    if (claimed.meta.changes !== 1) continue;
    try {
      await runCheck(db, plugins, user_id, provider, now);
    } catch (error) {
      // One user's failure never stops the others, and is tried again later;
      // nothing of the call is logged.
      console.warn(`provider check failed for ${PROVIDER_NAMES[provider] ?? provider}: ${error instanceof Error ? error.name : "error"}`);
      await db
        .prepare("UPDATE provider_checks SET next_try_at = ? WHERE user_id = ? AND provider = ?")
        .bind(minutesAfter(now, RETRY_MINUTES), user_id, provider)
        .run();
    }
  }
  return results.length;
}

// The providers this user has connected that a plug-in still serves.
export async function servedConnections(db: D1Database, plugins: PluginRegistry, userId: string): Promise<Provider[]> {
  return (await connectedProviders(db, userId)).filter((p): p is Provider => p in plugins);
}
