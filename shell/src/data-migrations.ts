// Data migrations (design-v3 8.4): backfills, reshaping rows, re-encrypting
// a user's vault. Not SQL files: jobs in the shell Worker that run user by
// user, in a fixed order, each step logged in `data_migration_steps`.
//
//   runDataMigration(db, job, now?) -> { done, skipped }
//
// A step reads what it needs and returns its writes as D1 statements; the
// runner commits those writes and the step's log row in one batch, which D1
// runs as one transaction. So a step either happened and is logged, or did
// neither: a step already logged is skipped, a job is safe to run twice, and
// an interrupted job resumes at the first step not logged. A step that also
// touches something outside D1 (moving R2 objects, say) must itself be safe to
// repeat, since it may run again if the job stops between that work and its
// commit.
//
// The schema a job needs ships first, through the expand-then-contract rule
// (README "D1 migrations"); a job starts after the Worker carrying it is live.

export interface DataMigrationStep {
  name: string;
  run(db: D1Database, userId: string): Promise<D1PreparedStatement[]>;
}

export interface DataMigrationJob {
  name: string;
  steps: readonly DataMigrationStep[];
}

export interface DataMigrationResult {
  // Steps run now, and steps skipped because an earlier run logged them.
  done: number;
  skipped: number;
}

export async function runDataMigration(db: D1Database, job: DataMigrationJob, now: () => Date = () => new Date()): Promise<DataMigrationResult> {
  const names = job.steps.map((s) => s.name);
  if (new Set(names).size !== names.length) throw new Error(`data migration ${job.name} has two steps with one name`);
  const { results: users } = await db.prepare("SELECT id FROM users ORDER BY id").all<{ id: string }>();
  const result: DataMigrationResult = { done: 0, skipped: 0 };
  for (const { id: userId } of users) {
    const { results: logged } = await db
      .prepare("SELECT step FROM data_migration_steps WHERE job = ? AND user_id = ?")
      .bind(job.name, userId)
      .all<{ step: string }>();
    const finished = new Set(logged.map((r) => r.step));
    for (const step of job.steps) {
      if (finished.has(step.name)) {
        result.skipped++;
        continue;
      }
      const writes = await step.run(db, userId);
      // ON CONFLICT DO NOTHING: two runs racing on one step keep one log row,
      // but D1 still runs the loser's writes, so a step's writes are
      // idempotent statements (upserts, guarded updates).
      const log = db
        .prepare("INSERT INTO data_migration_steps (job, user_id, step, done_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(job.name, userId, step.name, now().toISOString());
      await db.batch([...writes, log]);
      console.log(`data migration ${job.name}: user ${userId} step ${step.name} done`);
      result.done++;
    }
  }
  return result;
}

