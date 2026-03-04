export const up = `
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_id       SERIAL PRIMARY KEY,
    integration_id VARCHAR(100) NOT NULL,
    account_id     VARCHAR(200) NOT NULL DEFAULT 'default',
    provider_id    VARCHAR(100) NOT NULL,
    access_token   TEXT NOT NULL,
    refresh_token  TEXT,
    token_type     VARCHAR(50) NOT NULL DEFAULT 'Bearer',
    scope          TEXT,
    expires_at     BIGINT,
    raw_response   JSONB,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(integration_id, account_id)
  );

  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_integration ON oauth_tokens(integration_id);
  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider_id);
  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens(expires_at);
`;

export const down = `DROP TABLE IF EXISTS oauth_tokens CASCADE;`;
