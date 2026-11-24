// Provider connections (design-v3 1.4): one per user and provider. Written by
// the provider's Connect method (T16) and read by the proxy; nothing else
// writes or reads them. They hold nothing secret: only the fields the
// provider's plug-in declares are accepted, each a short plain string.

import type { ConnectionFields, ProviderPlugin } from "./plugin";

// Longer than any role ARN, tenant ID, endpoint or project ID.
const MAX_FIELD_LENGTH = 512;

export async function writeConnection(
  db: D1Database,
  userId: string,
  plugin: ProviderPlugin,
  fields: ConnectionFields,
  now: Date,
): Promise<void> {
  const declared = new Set(plugin.connectionFields);
  for (const [name, value] of Object.entries(fields)) {
    if (!declared.has(name)) throw new Error(`a ${plugin.provider} connection has no field "${name}"`);
    if (typeof value !== "string" || !value || value.length > MAX_FIELD_LENGTH) {
      throw new Error(`a ${plugin.provider} connection's "${name}" must be a non-empty string of at most ${MAX_FIELD_LENGTH} characters`);
    }
  }
  const missing = plugin.connectionFields.filter((name) => !(name in fields));
  if (missing.length) throw new Error(`a ${plugin.provider} connection needs ${missing.join(", ")}`);
  await db
    .prepare(
      `INSERT INTO provider_connections (user_id, provider, fields, plugin_version, connected_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (user_id, provider) DO UPDATE SET fields = excluded.fields, plugin_version = excluded.plugin_version,
         connected_at = excluded.connected_at`,
    )
    .bind(userId, plugin.provider, JSON.stringify(fields), plugin.version, now.toISOString())
    .run();
}

export async function readConnection(db: D1Database, userId: string, provider: string): Promise<ConnectionFields | undefined> {
  const row = await db
    .prepare("SELECT fields FROM provider_connections WHERE user_id = ? AND provider = ?")
    .bind(userId, provider)
    .first<{ fields: string }>();
  return row ? (JSON.parse(row.fields) as ConnectionFields) : undefined;
}

// The providers this user has connected, for Models › Setup.
export async function connectedProviders(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT provider FROM provider_connections WHERE user_id = ? ORDER BY provider")
    .bind(userId)
    .all<{ provider: string }>();
  return results.map((r) => r.provider);
}

export async function deleteConnection(db: D1Database, userId: string, provider: string): Promise<void> {
  await db.prepare("DELETE FROM provider_connections WHERE user_id = ? AND provider = ?").bind(userId, provider).run();
}
