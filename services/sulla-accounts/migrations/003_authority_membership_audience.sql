-- Pin the advertised membership audience separately from requested OIDC scopes.
-- Existing unpinned remote connections must be enrolled again; never guess it.
ALTER TABLE accounts.authorities ADD COLUMN membership_audience text;
