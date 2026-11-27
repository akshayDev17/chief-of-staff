// The models one user's own provider account offers (the owner's scout,
// 2026-11-27: OpenRouter's public list "can include models this user's
// settings would refuse"). Read with the user's own key from OpenRouter's
// /models/user, which honours the account's provider preferences, privacy
// settings and guardrails, by every Connect check (which picks its test model
// from it) and on Refresh model list.
// The model list still shows every model OpenRouter lists; one the account
// leaves out cannot be chosen, and says why.
//
//   readAccountList(db, userId, provider) -> AccountList | undefined
//   refreshAccountList(db, plugins, userId, provider, now) -> AccountList | { problem }
//   saveAccountList(db, userId, provider, ids, now)   what a Connect check read
//   deleteAccountList(db, userId, provider)   on Disconnect

import type { Provider } from "../prices/types";
import { readConnection } from "../proxy/connections";
import { ProviderRefusal, type PluginRegistry } from "../proxy/plugin";

export interface AccountList {
  readAt: string;
  models: Set<string>;
}

export async function readAccountList(db: D1Database, userId: string, provider: Provider): Promise<AccountList | undefined> {
  const r = await db
    .prepare("SELECT read_at, models FROM provider_model_lists WHERE user_id = ? AND provider = ?")
    .bind(userId, provider)
    .first<{ read_at: string; models: string }>();
  return r ? { readAt: r.read_at, models: new Set(JSON.parse(r.models) as string[]) } : undefined;
}

export async function refreshAccountList(
  db: D1Database,
  plugins: PluginRegistry,
  userId: string,
  provider: Provider,
  now: Date,
): Promise<AccountList | { problem: string }> {
  const plugin = plugins[provider];
  const connection = await readConnection(db, userId, provider);
  if (!plugin || !connection) return { problem: "That provider is not connected." };
  let ids: string[];
  try {
    ids = await plugin.connect.readAccountModels(await plugin.mintCredential(connection, { userId }));
  } catch (error) {
    const said = error instanceof ProviderRefusal ? ` (${error.refusal.status} ${error.refusal.errorName}${error.refusal.message ? `: ${error.refusal.message}` : ""})` : "";
    return { problem: `${plugin.connect.guide.short} did not give your account's model list${said}; the list below is its public one.` };
  }
  return saveAccountList(db, userId, provider, ids, now);
}

export async function saveAccountList(db: D1Database, userId: string, provider: Provider, ids: readonly string[], now: Date): Promise<AccountList> {
  await db
    .prepare(
      `INSERT INTO provider_model_lists (user_id, provider, read_at, models) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (user_id, provider) DO UPDATE SET read_at = excluded.read_at, models = excluded.models`,
    )
    .bind(userId, provider, now.toISOString(), JSON.stringify(ids))
    .run();
  return { readAt: now.toISOString(), models: new Set(ids) };
}

export async function deleteAccountList(db: D1Database, userId: string, provider: Provider): Promise<void> {
  await db.prepare("DELETE FROM provider_model_lists WHERE user_id = ? AND provider = ?").bind(userId, provider).run();
}
