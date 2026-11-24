-- Each user's monthly budget per provider (design-v3 1.8, T12). Required:
-- a provider with no row here cannot be called. No daily or per-model budget
-- exists, and there is no default: a row is made only when the user accepts
-- the suggestion or types their own value on Models › Setup › Budgets.

CREATE TABLE provider_budgets (
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,
  monthly_usd REAL NOT NULL CHECK (monthly_usd > 0),
  set_how TEXT NOT NULL CHECK (set_how IN ('accepted', 'typed')),
  set_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- The models each user has picked at each provider. Written by Add a model
-- (T17), which extends this table; read here for each budget's suggestion,
-- which is worked from the picked model's list price.
CREATE TABLE user_models (
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  location TEXT NOT NULL,                  -- the region or deployment type it runs in
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider, model)
);
