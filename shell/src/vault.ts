// The per-user vault (design-v3 1.4, 11.3): one per user, for both tiers.
//
// Each user has their own AES-256-GCM key, made at their first write and
// stored only wrapped (encrypted) by the one vault key in Secrets Store, so a
// read of D1 alone gives neither the users' keys nor their items. Each item is
// sealed with its user's key, and the user id and item name are bound into
// the seal as additional data, so a row copied to another user or another
// name does not open.
//
// What goes in: the key a model provider issued the app when the user
// authorized it at the provider (OpenRouter's OAuth PKCE; never a key the
// user pasted, which the app never asks for) and its PKCE verifier while the
// user is on the provider's page (src/providers/secrets.ts), and later the
// portal passwords, the Gmail token and the owner's NodeMaven details.
// Nothing in it is shown again after entry: openItem is for the code that
// uses the secret, never for a screen.
//
// The vault key is the Worker secret VAULT_KEY (README "Releasing the shell").

const AES = { name: "AES-GCM", length: 256 } as const;
const IV_BYTES = 12;

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const encode = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(text));

// Stored form of anything sealed: base64 of the IV followed by the ciphertext.
const joinIv = (iv: Uint8Array, sealed: ArrayBuffer): string => {
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), IV_BYTES);
  return toBase64(out);
};

// The vault key: 32 random bytes, base64, the one secret in Secrets Store
// that protects every user's key.
export async function importVaultKey(base64: string): Promise<CryptoKey> {
  const raw = fromBase64(base64.trim());
  if (raw.length !== 32) throw new Error("the vault key must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", raw, AES, false, ["wrapKey", "unwrapKey"]);
}

const seal = async (key: CryptoKey, plain: Uint8Array<ArrayBuffer>, aad: string): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  return joinIv(iv, await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encode(aad) }, key, plain));
};

const splitSealed = (text: string) => {
  const bytes = fromBase64(text);
  return { iv: bytes.slice(0, IV_BYTES), data: bytes.slice(IV_BYTES) };
};

const unwrapUserKey = (vaultKey: CryptoKey, wrapped: string, userId: string): Promise<CryptoKey> => {
  const { iv, data } = splitSealed(wrapped);
  return crypto.subtle.unwrapKey("raw", data, vaultKey, { name: "AES-GCM", iv, additionalData: encode(`user-key\0${userId}`) }, AES, false, [
    "encrypt",
    "decrypt",
  ]);
};

// The user's key, made and stored wrapped on first use. Two first writes at
// once keep whichever key landed first; both then use it.
async function userKey(db: D1Database, vaultKey: CryptoKey, userId: string, now: Date): Promise<CryptoKey> {
  const existing = await db.prepare("SELECT wrapped_key FROM vault_keys WHERE user_id = ?").bind(userId).first<{ wrapped_key: string }>();
  if (existing) return unwrapUserKey(vaultKey, existing.wrapped_key, userId);
  const fresh = (await crypto.subtle.generateKey(AES, true, ["encrypt", "decrypt"])) as CryptoKey;
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrapped = await crypto.subtle.wrapKey("raw", fresh, vaultKey, { name: "AES-GCM", iv, additionalData: encode(`user-key\0${userId}`) });
  await db
    .prepare("INSERT INTO vault_keys (user_id, wrapped_key, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING")
    .bind(userId, joinIv(iv, wrapped), now.toISOString())
    .run();
  const kept = await db.prepare("SELECT wrapped_key FROM vault_keys WHERE user_id = ?").bind(userId).first<{ wrapped_key: string }>();
  return unwrapUserKey(vaultKey, kept!.wrapped_key, userId);
}

const itemAad = (userId: string, name: string) => `item\0${userId}\0${name}`;

export async function storeItem(db: D1Database, vaultKey: CryptoKey, userId: string, name: string, value: string, now: Date): Promise<void> {
  const key = await userKey(db, vaultKey, userId, now);
  const sealed = await seal(key, encode(value), itemAad(userId, name));
  await db
    .prepare(
      `INSERT INTO vault_items (user_id, name, sealed, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (user_id, name) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at`,
    )
    .bind(userId, name, sealed, now.toISOString())
    .run();
}

// The item's value for the code that uses it; undefined when there is none.
export async function openItem(db: D1Database, vaultKey: CryptoKey, userId: string, name: string): Promise<string | undefined> {
  const row = await db
    .prepare("SELECT k.wrapped_key, i.sealed FROM vault_items i JOIN vault_keys k ON k.user_id = i.user_id WHERE i.user_id = ? AND i.name = ?")
    .bind(userId, name)
    .first<{ wrapped_key: string; sealed: string }>();
  if (!row) return undefined;
  const key = await unwrapUserKey(vaultKey, row.wrapped_key, userId);
  const { iv, data } = splitSealed(row.sealed);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encode(itemAad(userId, name)) }, key, data);
  return new TextDecoder().decode(plain);
}

// A user's file (src/files.ts) is sealed with the same user key, bound to
// the user and the file's R2 key, so a file copied to another user's prefix
// or another name does not open. The whole file is in memory while sealed.
const fileAad = (userId: string, key: string) => `file\0${userId}\0${key}`;

export async function sealUserFile(db: D1Database, vaultKey: CryptoKey, userId: string, key: string, bytes: Uint8Array<ArrayBuffer>, now: Date): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encode(fileAad(userId, key)) }, await userKey(db, vaultKey, userId, now), bytes);
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), IV_BYTES);
  return out;
}

// The file's bytes. A file sealed for another user or key fails, and so
// does any file of a user who has no key, since nothing of theirs was sealed.
export async function openUserFile(db: D1Database, vaultKey: CryptoKey, userId: string, key: string, sealed: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const row = await db.prepare("SELECT wrapped_key FROM vault_keys WHERE user_id = ?").bind(userId).first<{ wrapped_key: string }>();
  if (!row) throw new Error(`user ${userId} has no key, so no file of theirs was sealed`);
  const userKey = await unwrapUserKey(vaultKey, row.wrapped_key, userId);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, IV_BYTES), additionalData: encode(fileAad(userId, key)) }, userKey, sealed.slice(IV_BYTES));
  return new Uint8Array(plain);
}

// Removes one item; nothing to do when there is none.
export async function deleteItem(db: D1Database, userId: string, name: string): Promise<void> {
  await db.prepare("DELETE FROM vault_items WHERE user_id = ? AND name = ?").bind(userId, name).run();
}
