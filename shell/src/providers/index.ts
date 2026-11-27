// The registered provider plug-ins: one per "Connect <Provider>" button.
// OpenRouter is the only one (the owner, 2026-11-27). Its plug-in is given
// OpenRouter's own model list, stored with the current price snapshot
// (src/prices/openrouter.ts), which `readProviderPlugins` reads from D1 for
// each request, and the user's vault for the key OpenRouter issued
// (src/providers/secrets.ts).

import type { OpenRouterCatalog } from "../prices/openrouter";
import { readCurrentCatalog } from "../prices/store";
import type { PluginRegistry } from "../proxy/plugin";
import { openrouterPlugin, type OpenRouterEnv } from "./openrouter";
import { vaultSecrets, type SecretStore, type VaultEnv } from "./secrets";

export type ProvidersEnv = OpenRouterEnv & VaultEnv;

export const providerPlugins = (env: ProvidersEnv, secrets: SecretStore, catalog: OpenRouterCatalog | undefined, fetcher: typeof fetch = fetch): PluginRegistry => ({
  openrouter: openrouterPlugin(env, secrets, catalog, fetcher),
});

export const readProviderPlugins = async (env: ProvidersEnv, db: D1Database): Promise<PluginRegistry> =>
  providerPlugins(env, vaultSecrets(db, env), await readCurrentCatalog(db));
