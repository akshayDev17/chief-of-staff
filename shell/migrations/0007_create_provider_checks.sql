-- The Connect check of each provider connection (design-v3 1.5, T16): the
-- automatic test call's state and its last result, one row per user and
-- provider. Written only by src/providers/check.ts.
--
-- `result` is the last test call's three lines as shown to this user: the
-- plain reason, the provider's status, error name and its own message, and
-- for a pass the model, region, tokens and cost. It is never a prompt or a
-- task's reply, it is shown only to the user who made the call, and "Ask
-- Admin for help" never sends it.

CREATE TABLE provider_checks (
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,
  -- checking: the connection is written and the check has not answered yet;
  -- passed: a test call passed (the setup item is ticked);
  -- switching_on: the provider is still switching the model on, retried every 15 minutes;
  -- failed: the test call failed for a plain reason the user fixes;
  -- revoked: a connection that had passed lost its grant (T49 raises the alert).
  state TEXT NOT NULL CHECK (state IN ('checking', 'passed', 'switching_on', 'failed', 'revoked')),
  region TEXT,                             -- the test call's region or deployment type
  region_set_by TEXT CHECK (region_set_by IN ('app', 'user')),
  result TEXT,                             -- JSON: the last test call's three lines
  checked_at TEXT,
  next_try_at TEXT,                        -- the next automatic retry, while switching_on
  passed_at TEXT,
  revoked_at TEXT,
  -- Microsoft's admin consent: the request's state value and the non-secret
  -- fields typed before it (the endpoint), until Microsoft returns the tenant.
  consent_state TEXT,
  pending_fields TEXT,
  template_version TEXT,                   -- Bedrock: the version read from the user's own stack
  PRIMARY KEY (user_id, provider)
);

-- The cron's retry finds the checks that are due.
CREATE INDEX provider_checks_due ON provider_checks (state, next_try_at);

-- "Ask Admin for help" from a friend's setup screen: the item's name and its
-- plain reason only, never the provider's reply. Delivered to the owner by
-- T49's alerts; recorded here until then.
CREATE TABLE help_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users (id),
  item TEXT NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);
