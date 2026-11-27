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
import { ConnectProblem, type Link, type PlainReason, type PluginRegistry, type ProviderPlugin, type Usage } from "../proxy/plugin";
import { PROVIDER_NAMES, sendTestCall } from "../proxy/proxy";
import { deleteAccountList, refreshAccountList } from "../models/account-list";
import type { SecretStore } from "./secrets";

export const RETRY_MINUTES = 15;

// The key's credit limit prefilled on the provider's consent page when the
// user has no monthly budget at the provider yet; they can change it there.
export const DEFAULT_CREDIT_LIMIT_USD = 10;

export type CheckState = "checking" | "passed" | "failed" | "revoked";

// What waited instead of a test call.
export type Waiting = "budget_spent" | "no_price";

// The test call's three lines, for the user who made it only.
export interface CheckResult {
  at: string;
  verdict: "passed" | "failed";
  reason?: PlainReason | Waiting;
  model: string;
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
export function reasonText(reason: PlainReason | Waiting | undefined, plugin: ProviderPlugin, model: string): string {
  const { guide } = plugin.connect;
  switch (reason) {
    case "not_set_up":
      return "The connection isn't set up yet, or was removed.";
    case "no_credits":
      return `Your ${guide.name} account or this key is out of credits.`;
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
      return `${model} has no list price at ${guide.name} yet, so the test call waits for the price table.`;
    default:
      return `${guide.short} refused the test call.`;
  }
}

// The plain verdict, in the app's words: the first of the three lines.
export function verdictText(result: CheckResult, plugin: ProviderPlugin): string {
  return result.verdict === "passed" ? "Test call passed" : reasonText(result.reason, plugin, result.model);
}

// Makes the test call through the proxy, on the plug-in's own test model
// (never a model the user picked), then records the result.
export async function runCheck(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider, now: Date): Promise<Check | undefined> {
  const plugin = plugins[provider];
  const connection = await readConnection(db, userId, provider);
  const before = await readCheck(db, userId, provider);
  if (!plugin || !connection) return before;
  const model = plugin.connect.testModel;
  const location = plugin.connect.locations(model)[0] ?? "global";
  const base: Check = { ...(before ?? { provider, state: "checking" }), provider, checkedAt: now.toISOString(), consentState: before?.consentState };
  const head = { at: now.toISOString(), model, location };

  const wait = async (reason: Waiting, nextTryAt: string): Promise<Check> => {
    const result: CheckResult = { ...head, verdict: "failed", reason };
    const c: Check = { ...base, state: before?.state === "passed" || before?.state === "revoked" ? before.state : "failed", result, nextTryAt };
    await saveCheck(db, userId, c);
    return c;
  };
  const outcome = await sendTestCall(db, plugins, userId, { provider, model, location, request: plugin.connect.testRequest(model) }, () => now);
  if (outcome.kind === "refused" && outcome.reason === "budget_spent") return wait("budget_spent", nextMonthStart(now).toISOString());
  // No price, or the model list not read yet: the price table fills at the
  // next refresh.
  if (outcome.kind === "refused" && (outcome.reason === "no_price" || outcome.reason === "not_callable")) return wait("no_price", minutesAfter(now, RETRY_MINUTES));

  let result: CheckResult;
  if (outcome.kind === "answered") {
    result = { ...head, verdict: "passed", reply: { status: outcome.status, text: plugin.connect.replyText(outcome.body) }, usage: outcome.usage, costUsd: outcome.costUsd };
  } else if (outcome.failure) {
    const { failure } = outcome;
    const plain = plugin.connect.classify(failure, connection);
    result = {
      ...head,
      verdict: "failed",
      reason: plain.reason,
      reply: failure.step === "call" ? { status: failure.status, errorName: failure.errorName, message: failure.message } : undefined,
      note: failure.step === "credential" ? `The app holds no ${plugin.connect.guide.short} key for you.` : undefined,
      fix: plain.fix,
      links: plain.links,
    };
  } else if (outcome.kind === "refused" && outcome.missing) {
    result = { ...head, verdict: "failed", reason: "app_not_configured", note: `Admin's one-time setup is missing ${outcome.missing.join(", ")}.` };
  } else if (outcome.kind === "provider_error") {
    result = { ...head, verdict: "failed", reason: "no_reply", note: `${plugin.connect.guide.short} did not answer the test call.` };
  } else {
    // The connection went while the check ran.
    return before;
  }
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
  const checked = await runCheck(db, plugins, input.userId, input.provider, input.now);
  // The account's own model list, with the new key; best effort: the public
  // list stands in until Refresh model list reads it.
  if (checked?.state === "passed") await refreshAccountList(db, plugins, input.userId, input.provider, input.now);
  return { check: checked };
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
