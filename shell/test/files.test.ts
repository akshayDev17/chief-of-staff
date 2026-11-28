// Each user's files in R2 (src/files.ts): under the user's own prefix,
// sealed with the user's own key, and never another user's.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getUserFile, putUserFile, userFileKey, type FileStore } from "../src/files";
import { importVaultKey } from "../src/vault";
import { userFor, VAULT_KEY } from "./test-plugin";

const NOW = new Date("2026-11-29T09:00:00Z");
const store = async (): Promise<FileStore> => ({ bucket: env.FILES, db: env.DB, vaultKey: await importVaultKey(VAULT_KEY) });
const bytes = (text: string) => new Uint8Array(new TextEncoder().encode(text));

describe("a user's files", () => {
  it("are named under the user's own prefix", () => {
    expect(userFileKey("u-1", "resume", "morgan-sample.pdf")).toBe("users/u-1/resume/morgan-sample.pdf");
    expect(userFileKey("u-1", "browser-state", "linkedin/profile.tar")).toBe("users/u-1/browser-state/linkedin/profile.tar");
    for (const [user, kind, name] of [
      ["u/1", "resume", "a.pdf"],
      ["..", "resume", "a.pdf"],
      ["u-1", "Resume", "a.pdf"],
      ["u-1", "resume", "../u-2/resume/a.pdf"],
      ["u-1", "resume", "a//b"],
      ["u-1", "resume", ""],
    ] as const) {
      expect(() => userFileKey(user, kind, name), `${user} ${kind} ${name}`).toThrow();
    }
  });

  it("are stored sealed and read back whole by their own user", async () => {
    const files = await store();
    const user = await userFor("files-owner");
    const key = userFileKey(user.id, "resume", "morgan-sample.pdf");
    await putUserFile(files, user.id, key, bytes("Morgan Sample, resume"), NOW);
    const stored = await env.FILES.get(key);
    const raw = new TextDecoder().decode(await stored!.arrayBuffer());
    expect(raw).not.toContain("Morgan Sample");
    expect(new TextDecoder().decode(await getUserFile(files, user.id, key))).toBe("Morgan Sample, resume");
    expect(await getUserFile(files, user.id, userFileKey(user.id, "resume", "missing.pdf"))).toBeUndefined();
  });

  it("refuses another user's key, and a file copied into another user's prefix does not open", async () => {
    const files = await store();
    const a = await userFor("files-a");
    const b = await userFor("files-b");
    const aKey = userFileKey(a.id, "letter", "acme.txt");
    await putUserFile(files, a.id, aKey, bytes("Dear Acme"), NOW);
    await expect(getUserFile(files, b.id, aKey)).rejects.toThrow("not under this user's prefix");
    await expect(putUserFile(files, b.id, aKey, bytes("x"), NOW)).rejects.toThrow("not under this user's prefix");

    // B has a key of their own, so the copy reaches the seal check.
    await putUserFile(files, b.id, userFileKey(b.id, "letter", "own.txt"), bytes("mine"), NOW);
    const copied = await env.FILES.get(aKey);
    const bKey = userFileKey(b.id, "letter", "acme.txt");
    await env.FILES.put(bKey, await copied!.arrayBuffer(), { customMetadata: copied!.customMetadata! });
    await expect(getUserFile(files, b.id, bKey)).rejects.toThrow();
    // The same bytes under another of A's own names do not open either.
    const renamed = userFileKey(a.id, "letter", "other.txt");
    await env.FILES.put(renamed, await (await env.FILES.get(aKey))!.arrayBuffer(), { customMetadata: copied!.customMetadata! });
    await expect(getUserFile(files, a.id, renamed)).rejects.toThrow();
  });

  it("refuses an object that was not sealed, or one of a user who has no key", async () => {
    const files = await store();
    const user = await userFor("files-plain");
    const key = userFileKey(user.id, "mail", "plain.eml");
    await env.FILES.put(key, "not sealed");
    await expect(getUserFile(files, user.id, key)).rejects.toThrow("is not sealed as aes-256-gcm-v1");
    const marked = userFileKey(user.id, "mail", "marked.eml");
    await env.FILES.put(marked, "sealed by no one", { customMetadata: { seal: "aes-256-gcm-v1" } });
    await expect(getUserFile(files, user.id, marked)).rejects.toThrow("has no key, so no file of theirs was sealed");
  });
});
