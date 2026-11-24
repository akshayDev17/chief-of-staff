-- Add a model (design-v3 1.5, T17): a row in user_models is written only
-- when the model's test call passes. Foundry calls a model by the user's
-- deployment name, which the app fills in with the model ID and the user
-- changes if they named it differently; the other providers leave it empty.
-- `test_result` is the passed test call as shown to this user: the model ID,
-- the model the reply named, its text, tokens and cost. Never a prompt or a
-- task's reply, and shown only to the user who made the call.

ALTER TABLE user_models ADD COLUMN deployment TEXT;
ALTER TABLE user_models ADD COLUMN test_result TEXT;
