-- The data-migration log (design-v3 8.4, T12). A data migration is a job in
-- the shell Worker that runs user by user; each finished step is one row
-- here, written in the same transaction as the step's own writes, so a step
-- already logged is skipped and an interrupted job resumes where it stopped.
-- See src/data-migrations.ts.

CREATE TABLE data_migration_steps (
  job TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  step TEXT NOT NULL,
  done_at TEXT NOT NULL,
  PRIMARY KEY (job, user_id, step)
);
