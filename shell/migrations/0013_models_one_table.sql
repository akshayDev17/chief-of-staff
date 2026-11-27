-- Models › Setup › Providers as one table of models to test (the owner,
-- 2026-11-28), with no Add (the owner, 2026-11-27: "quite franky remove the
-- add feature altogether"): the models a user's tasks can use are the ones
-- whose latest test passed (src/models/usable.ts). Expand only: new tables,
-- new columns and new rows, nothing changed or removed, so the previous
-- Worker keeps working on this schema. user_models stays as it is and is no
-- longer read or written; a later migration may drop it.

-- A router OpenRouter prices by the model it picks for each call
-- (`pricing.prompt` "-1") has no price of its own, so the budget stop cannot
-- price its calls. The user's price cap gives it one: every call to it asks
-- OpenRouter for no model dearer than the cap (`provider.max_price`), and the
-- budget stop prices the call at the cap when OpenRouter reports no cost.
-- In USD per million tokens, like the price table.
CREATE TABLE model_price_caps (
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_usd_per_mtok REAL NOT NULL CHECK (input_usd_per_mtok > 0),
  output_usd_per_mtok REAL NOT NULL CHECK (output_usd_per_mtok > 0),
  set_at TEXT NOT NULL,                -- ISO 8601 UTC
  PRIMARY KEY (user_id, provider, model)
);

-- Each model's latest finished test, whichever way it ran: Test on its row,
-- Test all models or Retest failed. A passed one makes the model usable; a
-- later failed one takes it out. `result` is JSON, as in model_tests: the
-- passed test call for a pass, the plain reason and the provider's own reply
-- for a failure; shown only to the user who ran it.
CREATE TABLE model_latest_tests (
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('passed', 'failed')),
  result TEXT NOT NULL,                -- JSON, see above
  tested_at TEXT NOT NULL,             -- ISO 8601 UTC
  PRIMARY KEY (user_id, provider, model)
);

-- The tests already made: each model's newest of its latest Test all models
-- result and the passed test it was added with, so every model a task uses
-- today stays usable while that test is its latest (task_routes is left as
-- it is). A model added with no recorded test has no pass to carry over.
INSERT INTO model_latest_tests (user_id, provider, model, state, result, tested_at)
SELECT user_id, provider, model, state, result, tested_at FROM (
  SELECT user_id, provider, model, state, result, tested_at,
         row_number() OVER (PARTITION BY user_id, provider, model ORDER BY tested_at DESC, added_first) AS n
  FROM (
    SELECT user_id, provider, model, state, result, tested_at, 1 AS added_first FROM model_tests
     WHERE state IN ('passed', 'failed') AND result IS NOT NULL AND tested_at IS NOT NULL
    UNION ALL
    SELECT user_id, provider, model, 'passed', json_object('text', 'Works now.', 'test', json(test_result)),
           coalesce(json_extract(test_result, '$.at'), added_at), 0 FROM user_models
     WHERE test_result IS NOT NULL AND json_valid(test_result)
  )
) WHERE n = 1;

-- A Test all models run made on an older model list (an older catalog
-- version, src/prices/openrouter.ts CATALOG_VERSION) offers no Retest
-- failed. Retest failed reruns the run's failures in the same run.
ALTER TABLE model_test_runs ADD COLUMN catalog_version INTEGER;
ALTER TABLE model_test_runs ADD COLUMN retested_at TEXT;
ALTER TABLE model_test_runs ADD COLUMN retest_count INTEGER;
