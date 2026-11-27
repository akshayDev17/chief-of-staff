// Each provider connection's one secret, in the user's own vault
// (src/vault.ts, design-v3 11.3): the key the provider issued the app when
// the user authorized it (OpenRouter's OAuth PKCE), and, while the user is on
// the provider's consent page, the PKCE verifier. Nothing else reads or
// writes these items, and nothing here is ever shown, logged or sent to the
// browser.
//
// The vault key is the Worker secret VAULT_KEY (32 random bytes, base64).
// Without it nothing can be sealed or opened, and Connect says the app's own
// side is not set up.

import { AppNotConfigured } from "../app-config";
import { deleteItem, importVaultKey, openItem, storeItem } from "../vault";

export interface VaultEnv {
  VAULT_KEY?: string;
}

export type SecretKind = "key" | "verifier";

export interface SecretStore {
  put(userId: string, provider: string, kind: SecretKind, value: string, now: Date): Promise<void>;
  read(userId: string, provider: string, kind: SecretKind): Promise<string | undefined>;
  remove(userId: string, provider: string, kind: SecretKind): Promise<void>;
}

const itemName = (provider: string, kind: SecretKind): string => `provider-${kind}:${provider}`;

export function vaultSecrets(db: D1Database, env: VaultEnv): SecretStore {
  let key: Promise<CryptoKey> | undefined;
  const vaultKey = (): Promise<CryptoKey> => {
    if (!env.VAULT_KEY?.trim()) return Promise.reject(new AppNotConfigured(["VAULT_KEY"]));
    key ??= importVaultKey(env.VAULT_KEY);
    return key;
  };
  return {
    put: async (userId, provider, kind, value, now) => storeItem(db, await vaultKey(), userId, itemName(provider, kind), value, now),
    read: async (userId, provider, kind) => openItem(db, await vaultKey(), userId, itemName(provider, kind)),
    // Removing needs no key: the sealed row just goes.
    remove: (userId, provider, kind) => deleteItem(db, userId, itemName(provider, kind)),
  };
}
