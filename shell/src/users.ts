// The signed-in user is the verified Cloudflare Access identity (design-v3
// 11.3). Every user-owned row carries the id returned here, and every query
// that reads such a row is scoped to it. Only the owner signs in during M2,
// but nothing here assumes one user.

import type { AccessClaims } from "./access";

export interface User {
  id: string;
  email: string;
}

// Returns the user for a verified Access token, making the row at the first
// request. Undefined when the token names no person (a service token has
// neither `sub` nor `email`).
export async function userFromAccess(db: D1Database, claims: AccessClaims, now: Date): Promise<User | undefined> {
  if (typeof claims.sub !== "string" || !claims.sub || typeof claims.email !== "string" || !claims.email) return undefined;
  const row = await db
    .prepare(
      `INSERT INTO users (id, access_subject, email, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (access_subject) DO UPDATE SET email = excluded.email
       RETURNING id, email`,
    )
    .bind(crypto.randomUUID(), claims.sub, claims.email, now.toISOString())
    .first<{ id: string; email: string }>();
  return row ?? undefined;
}
