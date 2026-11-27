// The Connect check (design-v3 1.5, T16): the test call that runs by itself
// once a connection answers, its plain result, and its retries.
//
//   connectProvider(...)  "Connect <Provider>": the record, then the check
//   finishConsent(...)    back from a provider page (Microsoft's sign-in, then its admin consent)
//   runCheck(...)         mint a credential, make the test call, record the result
//   runDueChecks(...)     the cron, every minute: the checks whose next try is due
//
// After "Connect", while the provider-side grant is not there yet (the stack
// not created, the role not assigned), the check tries again every minute for
// an hour: the app "polls until the role answers". "Still switching this on"
// is tried again every 15 minutes until a call passes, which ticks the item.
// A connection that had passed and then loses its grant is recorded as
// revoked, for T49's urgent alert.
//
// A test call is a real call to the user's own provider, sent through the
// proxy (`sendTestCall`), which prices it, writes its ledger row (task
// `test_call`) and records a removed grant, as for every call. It needs the
// model's list price, as every call does; it runs before any budget is set
// (budgets come after providers on the setup checklist), and waits when one
// is set and spent.

import type { Provider } from "../prices/types";
import { AppNotConfigured } from "../issuer";
import { connectedAt, deleteConnection, readConnection, writeConnection } from "../proxy/connections";
import { nextMonthStart } from "../proxy/ledger";
import { ConnectProblem, type ConnectionFields, type ConnectStart, type Link, type PlainReason, type PluginRegistry, type ProviderPlugin, type Usage } from "../proxy/plugin";
import { PROVIDER_NAMES, sendTestCall } from "../proxy/proxy";

export const RETRY_MINUTES = 15;
export const POLL_MINUTES = 1;
export const SETUP_WINDOW_MINUTES = 60;

export type CheckState = "checking" | "passed" | "switching_on" | "failed" | "revoked";

// What waited instead of a test call.
export type Waiting = "budget_spent" | "no_price";

// The test call's three lines, for the user who made it only.
export interface CheckResult {
  at: string;
  verdict: "passed" | "switching_on" | "failed";
  reason?: PlainReason | Waiting;
  model: string;
  modelId: string;
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
  region?: string;
  regionSetBy?: "app" | "user";
  result?: CheckResult;
  checkedAt?: string;
  nextTryAt?: string;
  passedAt?: string;
  revokedAt?: string;
  consentState?: string;
  pendingFields?: Record<string, string>;
  templateVersion?: string;
}

interface CheckRecord {
  provider: Provider;
  state: CheckState;
  region: string | null;
  region_set_by: "app" | "user" | null;
  result: string | null;
  checked_at: string | null;
  next_try_at: string | null;
  passed_at: string | null;
  revoked_at: string | null;
  consent_state: string | null;
  pending_fields: string | null;
  template_version: string | null;
}

const toCheck = (r: CheckRecord): Check => ({
  provider: r.provider,
  state: r.state,
  region: r.region ?? undefined,
  regionSetBy: r.region_set_by ?? undefined,
  result: r.result ? (JSON.parse(r.result) as CheckResult) : undefined,
  checkedAt: r.checked_at ?? undefined,
  nextTryAt: r.next_try_at ?? undefined,
  passedAt: r.passed_at ?? undefined,
  revokedAt: r.revoked_at ?? undefined,
  consentState: r.consent_state ?? undefined,
  pendingFields: r.pending_fields ? (JSON.parse(r.pending_fields) as Record<string, string>) : undefined,
  templateVersion: r.template_version ?? undefined,
});

export async function readCheck(db: D1Database, userId: string, provider: string): Promise<Check | undefined> {
  const r = await db.prepare("SELECT * FROM provider_checks WHERE user_id = ? AND provider = ?").bind(userId, provider).first<CheckRecord>();
  return r ? toCheck(r) : undefined;
}

export async function readChecks(db: D1Database, userId: string): Promise<Check[]> {
  const { results } = await db.prepare("SELECT * FROM provider_checks WHERE user_id = ? ORDER BY provider").bind(userId).all<CheckRecord>();
  return results.map(toCheck);
}

async function saveCheck(db: D1Database, userId: string, c: Check): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provider_checks (user_id, provider, state, region, region_set_by, result, checked_at, next_try_at, passed_at,
         revoked_at, consent_state, pending_fields, template_version)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       ON CONFLICT (user_id, provider) DO UPDATE SET state = excluded.state, region = excluded.region,
         region_set_by = excluded.region_set_by, result = excluded.result, checked_at = excluded.checked_at,
         next_try_at = excluded.next_try_at, passed_at = excluded.passed_at, revoked_at = excluded.revoked_at,
         consent_state = excluded.consent_state, pending_fields = excluded.pending_fields,
         template_version = excluded.template_version`,
    )
    .bind(
      userId, c.provider, c.state, c.region ?? null, c.regionSetBy ?? null, c.result ? JSON.stringify(c.result) : null,
      c.checkedAt ?? null, c.nextTryAt ?? null, c.passedAt ?? null, c.revokedAt ?? null, c.consentState ?? null,
      c.pendingFields ? JSON.stringify(c.pendingFields) : null, c.templateVersion ?? null,
    )
    .run();
}

const minutesAfter = (now: Date, minutes: number): string => new Date(now.getTime() + minutes * 60_000).toISOString();

// The plain verdict, in the app's words: the first of the three lines.
export function verdictText(result: CheckResult, plugin: ProviderPlugin): string {
  const { guide } = plugin.connect;
  if (result.verdict === "passed") return "Test call passed";
  switch (result.reason) {
    case "switching_on":
      return `${guide.vendor} is still switching this on; we'll keep retrying and tick this item by ourselves.`;
    case "not_set_up":
      return "The connection isn't set up yet, or was removed.";
    case "not_allowed_yet":
      return "Your account isn't allowed to use this model yet.";
    case "no_such_model":
      return "That deployment name or model ID doesn't exist here.";
    case "region_unavailable":
      return "This region doesn't offer that model.";
    case "no_permission":
      return "Your provider account lacks permission.";
    case "data_retention":
      return "Your subscription blocks data retention this model needs.";
    case "busy":
      return "Busy or out of quota, not a setup fault.";
    case "app_not_configured":
      return `The app's own side of ${guide.name} isn't set up yet.`;
    case "no_reply":
      return `No reply from ${guide.short}.`;
    case "budget_spent":
      return `This month's budget for ${guide.name} is spent, so the test call waits until the 1st.`;
    case "no_price":
      return `${result.model} has no list price at ${guide.name} yet, so the test call waits for the price table.`;
    default:
      return `${guide.short} refused the test call.`;
  }
}

// The Connect test call's own IDs for `model`: the plug-in's test model's
// (`testModelIds`), where it has them, whatever the provider's list says.
const pinnedIds = (plugin: ProviderPlugin, model: string): Readonly<Record<string, string>> | undefined =>
  model === plugin.connect.testModel ? plugin.connect.testModelIds : undefined;

// Where the Connect test call can run on `model`, the app's default first.
export const testLocations = (plugin: ProviderPlugin, model: string): string[] => {
  const pinned = pinnedIds(plugin, model);
  return pinned ? Object.keys(pinned) : plugin.connect.locations(model);
};

// The test call's model and location: always the plug-in's own test model,
// never a model the user picked (one of those can need terms or a form the
// test model does not), at the region the user chose, else the app's default.
// Where the user also added the test model itself, its row gives the
// location to start from and, on Foundry, the deployment name they kept.
async function testChoice(
  db: D1Database,
  userId: string,
  plugin: ProviderPlugin,
  check: Check | undefined,
): Promise<{ model: string; location: string; locations: string[]; deployment?: string; pinnedId?: string }> {
  const model = plugin.connect.testModel;
  const added = await db
    .prepare("SELECT location, deployment FROM user_models WHERE user_id = ? AND provider = ? AND model = ?")
    .bind(userId, plugin.provider, model)
    .first<{ location: string; deployment: string | null }>();
  const locations = testLocations(plugin, model);
  const location = check?.region && locations.includes(check.region) ? check.region : added && locations.includes(added.location) ? added.location : locations[0]!;
  return { model, location, locations, deployment: added?.deployment ?? undefined, pinnedId: pinnedIds(plugin, model)?.[location] };
}

// Makes the test call through the proxy, then records the result.
export async function runCheck(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider, now: Date): Promise<Check | undefined> {
  const plugin = plugins[provider];
  const connection = await readConnection(db, userId, provider);
  const before = await readCheck(db, userId, provider);
  if (!plugin || !connection) return before;
  const { model, location, deployment, pinnedId } = await testChoice(db, userId, plugin, before);
  const modelId = pinnedId ?? plugin.connect.modelId(model, location) ?? model;
  const base: Check = {
    ...(before ?? { provider, state: "checking" }),
    provider,
    region: location,
    regionSetBy: before?.regionSetBy === "user" && before.region === location ? "user" : "app",
    checkedAt: now.toISOString(),
    consentState: undefined,
    pendingFields: undefined,
  };
  const head = { at: now.toISOString(), model, modelId, location };

  const wait = async (reason: Waiting, nextTryAt: string): Promise<Check> => {
    const result: CheckResult = { ...head, verdict: "failed", reason };
    const c: Check = { ...base, state: before?.state === "passed" || before?.state === "revoked" ? before.state : "failed", result, nextTryAt };
    await saveCheck(db, userId, c);
    return c;
  };
  const outcome = await sendTestCall(db, plugins, userId, { provider, model, location, deployment, modelId: pinnedId, request: plugin.connect.testRequest(model, location) }, () => now);
  if (outcome.kind === "refused" && outcome.reason === "budget_spent") return wait("budget_spent", nextMonthStart(now).toISOString());
  if (outcome.kind === "refused" && outcome.reason === "no_price") return wait("no_price", minutesAfter(now, RETRY_MINUTES));

  let result: CheckResult;
  if (outcome.kind === "answered") {
    result = { ...head, verdict: "passed", reply: { status: outcome.status, text: plugin.connect.replyText(outcome.body) }, usage: outcome.usage, costUsd: outcome.costUsd };
  } else if (outcome.failure) {
    const { failure } = outcome;
    const plain = plugin.connect.classify(failure, connection, before?.templateVersion);
    result = {
      ...head,
      verdict: plain.reason === "switching_on" ? "switching_on" : "failed",
      reason: plain.reason,
      reply: { status: failure.status, errorName: failure.errorName, message: failure.message },
      fix: plain.fix,
      links: plain.links,
    };
  } else if (outcome.kind === "refused" && outcome.missing) {
    result = { ...head, verdict: "failed", reason: "app_not_configured", note: `Admin's one-time setup is missing ${outcome.missing.join(", ")}.` };
  } else if (outcome.kind === "refused" && outcome.reason === "credential_failed") {
    result = { ...head, verdict: "failed", reason: "no_reply", note: `No answer from ${plugin.connect.guide.short} while connecting.` };
  } else if (outcome.kind === "provider_error") {
    result = { ...head, verdict: "failed", reason: "no_reply", note: `${plugin.connect.guide.short} did not answer the test call.` };
  } else {
    // The connection went while the check ran.
    return before;
  }
  const recorded = await record(db, userId, plugin, base, before, result, now);
  if (result.verdict === "passed") await refreshSetupVersion(db, plugin, userId, connection, recorded);
  return recorded;
}

// Bedrock: the template version in the user's own stack, read now with a
// credential of its own and kept on the check; best effort, so the version
// last read where this read fails.
export async function refreshSetupVersion(
  db: D1Database,
  plugin: ProviderPlugin,
  userId: string,
  connection: ConnectionFields,
  check: Check | undefined,
): Promise<string | undefined> {
  if (!plugin.connect.readSetupVersion || !check) return check?.templateVersion;
  const version = await plugin
    .mintCredential(connection, { userId })
    .then((credential) => plugin.connect.readSetupVersion?.(credential, connection))
    .catch(() => undefined);
  if (version && version !== check.templateVersion) {
    check.templateVersion = version;
    await db
      .prepare("UPDATE provider_checks SET template_version = ? WHERE user_id = ? AND provider = ?")
      .bind(version, userId, check.provider)
      .run();
  }
  return version ?? check.templateVersion;
}

// The state a result leaves the check in, and when it is tried again.
async function record(
  db: D1Database,
  userId: string,
  plugin: ProviderPlugin,
  base: Check,
  before: Check | undefined,
  result: CheckResult,
  now: Date,
): Promise<Check> {
  let c: Check;
  if (result.verdict === "passed") {
    c = { ...base, state: "passed", result, passedAt: now.toISOString(), revokedAt: undefined, nextTryAt: undefined };
  } else if (result.verdict === "switching_on") {
    c = { ...base, state: "switching_on", result, nextTryAt: minutesAfter(now, RETRY_MINUTES) };
  } else if (result.reason === "not_set_up" && before?.passedAt) {
    // It had passed: the grant was removed on the provider's side.
    c = { ...base, state: "revoked", result, revokedAt: before.revokedAt ?? now.toISOString(), nextTryAt: undefined };
  } else if (result.reason === "not_set_up") {
    // Waiting for the provider-side grant: poll for an hour after Connect.
    const since = (await connectedAt(db, userId, plugin.provider)) ?? now;
    const polling = now.getTime() - since.getTime() < SETUP_WINDOW_MINUTES * 60_000;
    c = { ...base, state: polling ? "checking" : "failed", result, nextTryAt: polling ? minutesAfter(now, POLL_MINUTES) : undefined };
  } else {
    c = { ...base, state: before?.state === "revoked" ? "revoked" : "failed", result, nextTryAt: undefined };
  }
  await saveCheck(db, userId, c);
  return c;
}

export type ConnectOutcome = { problem: string } | { open?: string; check?: Check };

const randomState = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

// "Connect <Provider>": checks the typed fields, then stores the record and
// runs the check, or sends the user to the provider's consent page.
export async function connectProvider(
  db: D1Database,
  plugins: PluginRegistry,
  input: { userId: string; provider: Provider; typed: Record<string, string>; appOrigin: string | undefined; now: Date },
): Promise<ConnectOutcome> {
  const plugin = plugins[input.provider];
  if (!plugin) return { problem: "That provider is not offered." };
  const typed: Record<string, string> = {};
  for (const field of plugin.connect.fields) {
    const value = (input.typed[field.name] ?? "").trim();
    if (!new RegExp(`^(?:${field.pattern})$`).test(value)) return { problem: field.problem };
    typed[field.name] = value;
  }
  if (!input.appOrigin) return { problem: `The app's own side of ${plugin.connect.guide.name} isn't set up yet: Admin's one-time setup is missing APP_ORIGIN.` };
  const consentState = randomState();
  const existing = await readConnection(db, input.userId, input.provider);
  let start;
  try {
    start = plugin.connect.start(typed, { userId: input.userId, appOrigin: input.appOrigin, consentState, existing });
  } catch (error) {
    if (error instanceof AppNotConfigured) return { problem: `The app's own side of ${plugin.connect.guide.name} isn't set up yet: Admin's one-time setup is missing ${error.missing.join(", ")}.` };
    if (error instanceof ConnectProblem) return { problem: error.message };
    throw error;
  }
  const before = await readCheck(db, input.userId, input.provider);
  if (start.kind === "consent") {
    await saveCheck(db, input.userId, { ...(before ?? { provider: input.provider, state: "checking" }), consentState, pendingFields: start.pending });
    return { open: start.open };
  }
  await writeConnection(db, input.userId, plugin, start.fields, input.now);
  // A new connection: it has not passed yet, whatever an earlier one did.
  await saveCheck(db, input.userId, {
    ...(before ?? {}), provider: input.provider, state: "checking", result: undefined, nextTryAt: input.now.toISOString(),
    passedAt: undefined, revokedAt: undefined, consentState: undefined, pendingFields: undefined,
  });
  return { open: start.open, check: await runCheck(db, plugins, input.userId, input.provider, input.now) };
}

// Back from a provider page, which must return the state value this user's
// Connect sent; the plug-in's own pending fields say which page it was. The
// state is spent
// before anything else is done with the answer, so it works once, even when
// two answers race; the next page gets a new one.
export async function finishConsent(
  db: D1Database,
  plugins: PluginRegistry,
  input: { userId: string; provider: Provider; returned: URLSearchParams; appOrigin: string | undefined; now: Date },
): Promise<ConnectOutcome> {
  const plugin = plugins[input.provider];
  const check = await readCheck(db, input.userId, input.provider);
  const notThis = { problem: `That answer from ${plugin?.connect.guide.vendor ?? "the provider"} was not for this Connect. Tap Connect ${plugin?.connect.guide.name ?? "again"} again.` };
  const state = input.returned.get("state");
  if (!plugin?.connect.finish || !check?.consentState || !check.pendingFields || !state || state !== check.consentState) return notThis;
  const spent = await db
    .prepare("UPDATE provider_checks SET consent_state = NULL, pending_fields = NULL WHERE user_id = ? AND provider = ? AND consent_state = ?")
    .bind(input.userId, input.provider, state)
    .run();
  if (spent.meta.changes !== 1) return notThis;
  const pending = check.pendingFields;
  if (!input.appOrigin) return { problem: `The app's own side of ${plugin.connect.guide.name} isn't set up yet: Admin's one-time setup is missing APP_ORIGIN.` };
  const spentCheck: Check = { ...check, consentState: undefined, pendingFields: undefined };
  const nextState = randomState();
  let next: ConnectStart;
  try {
    next = await plugin.connect.finish(pending, input.returned, { appOrigin: input.appOrigin, consentState: nextState });
  } catch (error) {
    if (error instanceof ConnectProblem) return { problem: error.message };
    if (error instanceof AppNotConfigured) return { problem: `The app's own side of ${plugin.connect.guide.name} isn't set up yet: Admin's one-time setup is missing ${error.missing.join(", ")}.` };
    throw error;
  }
  if (next.kind === "consent") {
    // The next provider page, with a state of its own.
    await saveCheck(db, input.userId, { ...spentCheck, consentState: nextState, pendingFields: next.pending });
    return { open: next.open };
  }
  await writeConnection(db, input.userId, plugin, next.fields, input.now);
  await saveCheck(db, input.userId, {
    ...spentCheck, state: "checking", result: undefined, passedAt: undefined, revokedAt: undefined, nextTryAt: input.now.toISOString(),
  });
  return { check: await runCheck(db, plugins, input.userId, input.provider, input.now) };
}

// Saving a budget: a test call waiting for this provider's spent budget
// runs again at once, so a raised budget lets it through without waiting for
// the 1st (one still spent waits as before, with no call made).
export async function rerunBudgetWait(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider, now: Date): Promise<void> {
  const check = await readCheck(db, userId, provider);
  if (check?.result?.reason === "budget_spent") await runCheck(db, plugins, userId, provider, now);
}

// The user's own choice of region for the test call (and the picker's default).
export async function chooseRegion(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider, region: string, now: Date): Promise<string | undefined> {
  const plugin = plugins[provider];
  const check = await readCheck(db, userId, provider);
  if (!plugin || !check || !(await readConnection(db, userId, provider))) return "That provider is not connected.";
  const { model, locations } = await testChoice(db, userId, plugin, undefined);
  if (!locations.includes(region)) return `${model} is not offered at that region by ${plugin.connect.guide.name}.`;
  await saveCheck(db, userId, { ...check, region, regionSetBy: "user" });
  await runCheck(db, plugins, userId, provider, now);
  return undefined;
}

// Disconnect: the record and its check go; the provider's models stop
// answering for this user at once. The grant on the provider's side is the
// user's to remove (the guide says how).
export async function disconnectProvider(db: D1Database, userId: string, provider: Provider): Promise<void> {
  await deleteConnection(db, userId, provider);
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
export async function runDueChecks(db: D1Database, plugins: PluginRegistry, now: Date, limit = 25): Promise<number> {
  const { results } = await db
    .prepare("SELECT user_id, provider FROM provider_checks WHERE next_try_at IS NOT NULL AND next_try_at <= ? ORDER BY next_try_at LIMIT ?")
    .bind(now.toISOString(), limit)
    .all<{ user_id: string; provider: Provider }>();
  for (const { user_id, provider } of results) {
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
