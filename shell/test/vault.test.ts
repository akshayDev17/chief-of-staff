import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readConnection, writeConnection } from "../src/proxy/connections";
import { importVaultKey, openItem, storeItem } from "../src/vault";
import { dumpEveryTable, testPlugin, userFor } from "./test-plugin";

const NOW = new Date("2026-11-25T10:00:00Z");
// Made per run; no real key is ever in the repository.
const vaultKeyText = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const PASTED = "pasted-key-0123456789abcdef";

let vaultKey: CryptoKey;
let owner: string;
let friend: string;

beforeEach(async () => {
  vaultKey = await importVaultKey(vaultKeyText());
  owner = (await userFor("owner-sub")).id;
  friend = (await userFor("friend-sub")).id;
});

describe("the per-user vault", () => {
  it("gives back what was stored, and stores it only sealed", async () => {
    await storeItem(env.DB, vaultKey, owner, "portal:jobs.example.com", PASTED, NOW);
    expect(await openItem(env.DB, vaultKey, owner, "portal:jobs.example.com")).toBe(PASTED);
    expect(JSON.stringify(await dumpEveryTable())).not.toContain(PASTED);
  });

  it("gives each user their own key", async () => {
    await storeItem(env.DB, vaultKey, owner, "a", "one", NOW);
    await storeItem(env.DB, vaultKey, friend, "a", "two", NOW);
    const { results } = await env.DB.prepare("SELECT user_id, wrapped_key FROM vault_keys").all<{ wrapped_key: string }>();
    expect(results).toHaveLength(2);
    expect(results[0]!.wrapped_key).not.toBe(results[1]!.wrapped_key);
    expect(await openItem(env.DB, vaultKey, owner, "a")).toBe("one");
    expect(await openItem(env.DB, vaultKey, friend, "a")).toBe("two");
  });

  it("does not open one user's item copied into another user's vault", async () => {
    await storeItem(env.DB, vaultKey, owner, "gmail", PASTED, NOW);
    await storeItem(env.DB, vaultKey, friend, "other", "x", NOW);
    await env.DB.prepare("INSERT INTO vault_items (user_id, name, sealed, updated_at) SELECT ?, 'gmail', sealed, updated_at FROM vault_items WHERE user_id = ?")
      .bind(friend, owner)
      .run();
    await expect(openItem(env.DB, vaultKey, friend, "gmail")).rejects.toThrow();
  });

  it("opens nothing without the vault key it was sealed under", async () => {
    await storeItem(env.DB, vaultKey, owner, "gmail", PASTED, NOW);
    await expect(openItem(env.DB, await importVaultKey(vaultKeyText()), owner, "gmail")).rejects.toThrow();
  });

  it("refuses a vault key that is not 32 bytes", async () => {
    await expect(importVaultKey(btoa("short"))).rejects.toThrow(/32 bytes/);
  });
});

describe("provider connections hold nothing secret", () => {
  const plugin = testPlugin("bedrock");

  it("keep only the plug-in's declared fields, and only for their user", async () => {
    await writeConnection(env.DB, owner, plugin, { account: "123456789012", region: "global" }, NOW);
    expect(await readConnection(env.DB, owner, "bedrock")).toEqual({ account: "123456789012", region: "global" });
    expect(await readConnection(env.DB, friend, "bedrock")).toBeUndefined();
  });

  it("refuse a field the plug-in does not declare, such as a key", async () => {
    await expect(
      writeConnection(env.DB, owner, plugin, { account: "123456789012", region: "global", apiKey: PASTED }, NOW),
    ).rejects.toThrow(/no field "apiKey"/);
    await expect(writeConnection(env.DB, owner, plugin, { account: "123456789012" }, NOW)).rejects.toThrow(/needs region/);
    expect(JSON.stringify(await dumpEveryTable())).not.toContain(PASTED);
  });

  it("leave no minted credential in any stored row", async () => {
    await writeConnection(env.DB, owner, plugin, { account: "123456789012", region: "global" }, NOW);
    const credential = (await plugin.mintCredential((await readConnection(env.DB, owner, "bedrock"))!)) as string;
    expect(JSON.stringify(await dumpEveryTable())).not.toContain(credential);
  });
});
