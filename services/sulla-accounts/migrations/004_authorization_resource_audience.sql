-- Bind callback acceptance to the service audience selected at authorization start.
-- Pre-upgrade in-flight transactions have no pin and must restart sign-in.
ALTER TABLE accounts.authorization_transactions ADD COLUMN resource_audience text;
