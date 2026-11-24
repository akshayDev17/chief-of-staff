-- after: 0005_create_data_migration_log.sql
--
-- The made-up persona's rows (testdata/persona: Morgan Sample), the only data
-- the migration check's database holds (scripts/check-migrations.mjs). Written
-- at the schema of the migration named on the first line and never edited
-- after: every later migration is applied on top of these rows, the way it
-- will be on the deployed database. Every value is invented.

INSERT INTO users (id, access_subject, email, created_at)
  VALUES ('00000000-0000-4000-8000-000000000001', 'persona-morgan-sample', 'morgan.sample@example.com', '2026-11-25T00:00:00Z');

INSERT INTO provider_connections (user_id, provider, fields, plugin_version, connected_at)
  VALUES ('00000000-0000-4000-8000-000000000001', 'bedrock',
    '{"roleArn":"arn:aws:iam::123456789012:role/example","externalId":"example-external-id"}', 'example-1', '2026-11-25T00:00:00Z');

INSERT INTO provider_budgets (user_id, provider, monthly_usd, set_how, set_at)
  VALUES ('00000000-0000-4000-8000-000000000001', 'bedrock', 20, 'accepted', '2026-11-25T00:00:00Z');

INSERT INTO user_models (user_id, provider, model, location, added_at)
  VALUES ('00000000-0000-4000-8000-000000000001', 'bedrock', 'example-model', 'global', '2026-11-25T00:00:00Z');

INSERT INTO model_calls (user_id, at, task, site, provider, model, region, tier, plugin_version, status, fallback,
    input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, duration_ms, cost_usd)
  VALUES ('00000000-0000-4000-8000-000000000001', '2026-11-25T00:00:00Z', 'fill', 'jobs.example.com', 'bedrock',
    'example-model', 'global', 'Middle', 'example-1', 200, 0, 7000, 0, 0, 300, 1200, 0.017);

INSERT INTO data_migration_steps (job, user_id, step, done_at)
  VALUES ('example-job', '00000000-0000-4000-8000-000000000001', 'example-step', '2026-11-25T00:00:00Z');
