// The Connect step (design-v3 1.5, T16): Connect through the provider's own
// consent page, and the connection's state.
//
//   connectProvider(...)   "Connect <Provider>": the provider's consent page to open
//   finishConsent(...)     back from that page: the key into the vault, the record, the account's model list
//   disconnectProvider()   the key, the record and the state go
//
// No test call runs by itself (the owner, 2026-11-27: "the post connect
// step, where authorization from openrouter succeeds, should be to
// scroll/highlight the testing section"). Once the provider has issued the
// app its key, the connection is connected, and the page opens at the model
// table, where every model the account can use reads Ready with no test
// (models/ready.ts). Back from the consent page, the account's own model
// list is read with the new key and saved (it costs nothing), so the model
// list can mark the models the account leaves out.
//
// The state is kept in `provider_checks` (migration 0007), whose `state`
// values are fixed by its CHECK: `checking` while the user is on the consent
// page before any connection, `passed` once the provider authorized the app
// (the setup item's connected state; no test call is implied since
// 2026-11-27), and `revoked` when a test call found the key deleted or
// disabled on the provider's side, for T49's urgent alert. Rows written
// before 2026-11-27 can hold `failed` and an old test result, which nothing
// reads any more: a stored connection that is not revoked is connected.

import { AppNotConfigured } from "../app-config";
import type { Provider } from "../prices/types";
import { readBudget } from "../proxy/budgets";
import { deleteConnection, writeConnection } from "../proxy/connections";
import { ConnectProblem, type PlainReason, type PluginRegistry, type ProviderPlugin } from "../proxy/plugin";
import { deleteAccountList, refreshAccountList } from "../models/account-list";
import type { SecretStore } from "./secrets";

// The key's credit limit prefilled on the provider's consent page when the
// user has no monthly budget at the provider yet; they can change it there.
export const DEFAULT_CREDIT_LIMIT_USD = 10;

export type CheckState = "checking" | "passed" | "failed" | "revoked";

export interface Check {
  provider: Provider;
  state: CheckState;
  // When the provider authorized the app.
  passedAt?: string;
  revokedAt?: string;
  // While the user is on the provider's consent page: the state value it
  // must send back.
  consentState?: string;
}

interface CheckRecord {
  provider: Provider;
  state: CheckState;
  passed_at: string | null;
  revoked_at: string | null;
  consent_state: string | null;
}

const toCheck = (r: CheckRecord): Check => ({
  provider: r.provider,
  state: r.state,
  passedAt: r.passed_at ?? undefined,
  revokedAt: r.revoked_at ?? undefined,
  consentState: r.consent_state ?? undefined,
});

export async function readCheck(db: D1Database, userId: string, provider: string): Promise<Check | undefined> {
  const r = await db
    .prepare("SELECT provider, state, passed_at, revoked_at, consent_state FROM provider_checks WHERE user_id = ? AND provider = ?")
    .bind(userId, provider)
    .first<CheckRecord>();
  return r ? toCheck(r) : undefined;
}

// The old test result and retry columns are cleared on every write.
async function saveCheck(db: D1Database, userId: string, c: Check): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provider_checks (user_id, provider, state, result, checked_at, next_try_at, passed_at, revoked_at, consent_state)
       VALUES (?1, ?2, ?3, NULL, NULL, NULL, ?4, ?5, ?6)
       ON CONFLICT (user_id, provider) DO UPDATE SET state = excluded.state, result = NULL, checked_at = NULL, next_try_at = NULL,
         passed_at = excluded.passed_at, revoked_at = excluded.revoked_at, consent_state = excluded.consent_state`,
    )
    .bind(userId, c.provider, c.state, c.passedAt ?? null, c.revokedAt ?? null, c.consentState ?? null)
    .run();
}

// Whether a stored connection is connected: it is, unless a test call found
// its key removed on the provider's side.
export const isConnected = (connection: unknown, check: Check | undefined): boolean => connection !== undefined && check?.state !== "revoked";

// The plain sentence for a reason: the first line of a test call's result.
export function reasonText(reason: PlainReason | undefined, plugin: ProviderPlugin): string {
  const { name, short } = plugin.connect.guide;
  switch (reason) {
    case "not_set_up":
      return "The connection isn't set up, or was removed.";
    case "no_credits":
      return `Needs credit on ${name}.`;
    case "no_such_model":
      return "That model ID doesn't exist here.";
    case "no_fit":
      return "No model fits your settings or this price cap.";
    case "no_permission":
      return `${short} refused this request for your account.`;
    case "busy":
      return "Busy or out of quota, not a setup fault.";
    case "app_not_configured":
      return `The app's side of ${name} isn't set up yet.`;
    case "no_reply":
      return `No reply from ${short}.`;
    default:
      return `${short} refused the call.`;
  }
}

export type ConnectOutcome = { problem: string } | { open: string } | { connected: true };

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
  const start = await plugin.connect.start({ callbackUrl: input.callbackUrl, consentState, creditLimitUsd, now: input.now });
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
// code is traded for the key, which goes into the vault; the connection is
// connected, and the account's own model list is read with the new key.
// No model call is made.
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
  await saveCheck(db, input.userId, { provider: input.provider, state: "passed", passedAt: input.now.toISOString() });
  // A list that cannot be read now leaves the public one, marked as such;
  // Refresh model list reads it again.
  await refreshAccountList(db, plugins, input.userId, input.provider, input.now);
  return { connected: true };
}

// Disconnect: the key leaves the vault, and the record and its state go; the
// provider's models stop answering for this user at once. The key itself
// stays valid on the provider's side until the user deletes it there:
// OpenRouter's delete-a-key API takes only a management key (openrouter.ts),
// so the app cannot.
export async function disconnectProvider(db: D1Database, secrets: SecretStore, userId: string, provider: Provider): Promise<void> {
  await secrets.remove(userId, provider, "key");
  await secrets.remove(userId, provider, "verifier");
  await deleteConnection(db, userId, provider);
  await deleteAccountList(db, userId, provider);
  await db.prepare("DELETE FROM provider_checks WHERE user_id = ? AND provider = ?").bind(userId, provider).run();
}
