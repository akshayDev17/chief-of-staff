// A real call found the grant gone (the plug-in's own reading of the
// provider's refusal is "not set up, or removed"): a connection whose test
// call had passed is recorded as revoked, at once. T49 raises the urgent
// alert from this state, with one tap to connect again.

export async function recordGrantRefused(db: D1Database, userId: string, provider: string, now: Date): Promise<void> {
  await db
    .prepare(
      `UPDATE provider_checks SET state = 'revoked', revoked_at = ?1, next_try_at = NULL
       WHERE user_id = ?2 AND provider = ?3 AND passed_at IS NOT NULL AND state != 'revoked'`,
    )
    .bind(now.toISOString(), userId, provider)
    .run();
}
