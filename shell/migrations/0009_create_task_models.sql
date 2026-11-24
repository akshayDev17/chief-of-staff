-- Model for each task (design-v3 1.5, T18): the main model and the fallback
-- on another provider each user chose for each task, by accepting the
-- proposal or changing it. Both name one of the user's own passed models
-- (user_models); a row whose model is no longer there is ignored and the
-- task goes back to its proposal. No row: with one passed model the task
-- uses it, otherwise the task has no model until the user accepts or
-- changes it.

CREATE TABLE task_models (
  user_id TEXT NOT NULL REFERENCES users (id),
  task TEXT NOT NULL,
  main_provider TEXT NOT NULL,
  main_model TEXT NOT NULL,
  fallback_provider TEXT,
  fallback_model TEXT,
  set_how TEXT NOT NULL CHECK (set_how IN ('accepted', 'changed')),
  set_at TEXT NOT NULL,
  PRIMARY KEY (user_id, task),
  CHECK ((fallback_provider IS NULL) = (fallback_model IS NULL)),
  CHECK (fallback_provider IS NULL OR fallback_provider <> main_provider)
);
