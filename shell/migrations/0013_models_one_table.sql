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
-- verdict and the passed test it was added with, so every model a task uses
-- today stays usable while that test is its latest (no task_routes row is
-- changed). A model added with no recorded test has no pass to carry over.
-- A run's refusal that says nothing about the model is no verdict, as in
-- src/models/test-model.ts isVerdict, and is not carried: busy, no credit,
-- no key (not_set_up), the budget spent, not connected, the app's own setup
-- missing, and no reply with no reply from the provider (no credential, or
-- "The test could not run."), or no reason at all. A no_reply row with no
-- reply is skipped whatever caused it: the old rows cannot tell a credential
-- failure from a provider that did not answer the test call (the old code
-- stored no note), so such a model keeps its add-time pass and its routes,
-- the cautious reading.
INSERT INTO model_latest_tests (user_id, provider, model, state, result, tested_at)
SELECT user_id, provider, model, state, result, tested_at FROM (
  SELECT user_id, provider, model, state, result, tested_at,
         row_number() OVER (PARTITION BY user_id, provider, model ORDER BY tested_at DESC, added_first) AS n
  FROM (
    SELECT user_id, provider, model, state, result, tested_at, 1 AS added_first FROM model_tests
     WHERE state IN ('passed', 'failed') AND result IS NOT NULL AND tested_at IS NOT NULL
       AND (state = 'passed' OR (
         json_extract(result, '$.reason') IS NOT NULL
         AND json_extract(result, '$.reason') NOT IN ('busy', 'no_credits', 'not_set_up', 'budget_spent', 'not_connected', 'app_not_configured')
         AND NOT (json_extract(result, '$.reason') = 'no_reply' AND json_extract(result, '$.reply') IS NULL)
       ))
    UNION ALL
    SELECT user_id, provider, model, 'passed', json_object('text', 'Works now.', 'test', json(test_result)),
           coalesce(json_extract(test_result, '$.at'), added_at), 0 FROM user_models
     WHERE test_result IS NOT NULL AND json_valid(test_result)
  )
) WHERE n = 1;

-- The route every task with no saved choice took until now: the user's one
-- added model at a provider a plug-in serves (openrouter today), unless the
-- current model list names it free. A task with no saved choice now has no
-- model, so each of those tasks keeps that model as an accepted choice, with
-- no fallback. The task IDs are src/models/tasks.ts TASKS.
INSERT INTO task_routes (user_id, task, main_provider, main_model, fallback_provider, fallback_model, set_how, set_at)
SELECT u.user_id, t.column1, u.provider, u.model, NULL, NULL, 'accepted', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM user_models AS u
CROSS JOIN (VALUES ('match'), ('extract'), ('score'), ('fill_form'), ('check_form'), ('cover_letter'), ('free_text'), ('linkedin_message')) AS t
WHERE u.provider = 'openrouter'
  AND (SELECT count(*) FROM user_models AS o WHERE o.user_id = u.user_id AND o.provider = 'openrouter') = 1
  AND NOT EXISTS (
    SELECT 1 FROM openrouter_catalogs AS c, json_each(c.catalog, '$.models') AS m
    WHERE c.snapshot_id = (SELECT id FROM price_snapshots WHERE status != 'rolled_back' ORDER BY id DESC LIMIT 1)
      AND json_extract(m.value, '$.id') = u.model AND json_extract(m.value, '$.free') = 1
  )
  AND NOT EXISTS (SELECT 1 FROM task_routes AS r WHERE r.user_id = u.user_id AND r.task = t.column1)
ON CONFLICT DO NOTHING;

-- A Test all models run made on an older model list (an older catalog
-- version, src/prices/openrouter.ts CATALOG_VERSION) offers no Retest
-- failed. Retest failed reruns the run's failures in the same run.
ALTER TABLE model_test_runs ADD COLUMN catalog_version INTEGER;
ALTER TABLE model_test_runs ADD COLUMN retested_at TEXT;
ALTER TABLE model_test_runs ADD COLUMN retest_count INTEGER;
