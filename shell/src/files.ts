// Each user's files in R2 (design-v3 8.4, 11.3): resumes, cover letters,
// screenshots and submission evidence, the LinkedIn export, passed mail and
// saved browser sign-in state, each under that user's own prefix and sealed
// with that user's own key (src/vault.ts) before it is written.
//
//   userFileKey(userId, kind, name)                        -> "users/<userId>/<kind>/<name>"
//   putUserFile(store, userId, key, bytes, now)            -> writes the sealed file
//   getUserFile(store, userId, key)                        -> the file's bytes, or undefined
//
// A key outside the user's own prefix is refused, so code serving one user
// cannot name another's file. The bucket binding arrives with the first
// code that stores a file (`files.cos`, T21 part B, or the ticket that needs
// it first); nothing writes to R2 yet.

import { openUserFile, sealUserFile } from "./vault";

export interface FileStore {
  bucket: R2Bucket;
  db: D1Database;
  vaultKey: CryptoKey;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;
// The seal's form, kept on each object so a later form can be told apart.
const SEAL = "aes-256-gcm-v1";

const userPrefix = (userId: string): string => {
  if (!SEGMENT.test(userId) || userId === "." || userId === "..") throw new Error("a user id is one path segment");
  return `users/${userId}/`;
};

// `kind` is one lowercase word or words joined by dashes (resume,
// linkedin-export); `name` is one or more path segments, none `.` or `..`.
export function userFileKey(userId: string, kind: string, name: string): string {
  if (!/^[a-z]+(-[a-z]+)*$/.test(kind)) throw new Error("a file kind is lowercase words joined by dashes");
  const segments = name.split("/");
  if (!segments.every((s) => SEGMENT.test(s) && s !== "." && s !== "..")) throw new Error("a file name is path segments of letters, digits, dots, dashes and underscores");
  return `${userPrefix(userId)}${kind}/${name}`;
}

const ownKey = (userId: string, key: string): string => {
  if (!key.startsWith(userPrefix(userId))) throw new Error("that file is not under this user's prefix");
  return key;
};

export async function putUserFile(store: FileStore, userId: string, key: string, bytes: Uint8Array<ArrayBuffer>, now: Date): Promise<void> {
  const sealed = await sealUserFile(store.db, store.vaultKey, userId, ownKey(userId, key), bytes, now);
  await store.bucket.put(key, sealed, { customMetadata: { seal: SEAL } });
}

export async function getUserFile(store: FileStore, userId: string, key: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const object = await store.bucket.get(ownKey(userId, key));
  if (!object) return undefined;
  if (object.customMetadata?.seal !== SEAL) throw new Error(`file ${key} is not sealed as ${SEAL}`);
  return openUserFile(store.db, store.vaultKey, userId, key, new Uint8Array(await object.arrayBuffer()));
}
