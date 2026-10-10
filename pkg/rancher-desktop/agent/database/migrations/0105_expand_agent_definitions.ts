/** Lossless, marketplace-aware custom-agent storage.
 *
 * 0089 introduced the shared agent_definitions table for workflow planning.
 * These columns make the same row the source of truth for runnable custom
 * agents without discarding fields that older config.yaml files may contain.
 */
export const up = `
  ALTER TABLE agent_definitions
    ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS prompt_content TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS goals_content TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS prompt_files JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS provider TEXT,
    ADD COLUMN IF NOT EXISTS model TEXT,
    ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'local'
      CHECK (source_kind IN ('local', 'filesystem-import', 'marketplace')),
    ADD COLUMN IF NOT EXISTS marketplace_template_id TEXT,
    ADD COLUMN IF NOT EXISTS marketplace_slug TEXT,
    ADD COLUMN IF NOT EXISTS marketplace_version TEXT,
    ADD COLUMN IF NOT EXISTS marketplace_author TEXT;

  CREATE INDEX IF NOT EXISTS idx_agent_definitions_marketplace
    ON agent_definitions (marketplace_template_id)
    WHERE marketplace_template_id IS NOT NULL;
`;

export const down = `
  DROP INDEX IF EXISTS idx_agent_definitions_marketplace;
  ALTER TABLE agent_definitions
    DROP COLUMN IF EXISTS marketplace_author,
    DROP COLUMN IF EXISTS marketplace_version,
    DROP COLUMN IF EXISTS marketplace_slug,
    DROP COLUMN IF EXISTS marketplace_template_id,
    DROP COLUMN IF EXISTS source_kind,
    DROP COLUMN IF EXISTS model,
    DROP COLUMN IF EXISTS provider,
    DROP COLUMN IF EXISTS prompt_files,
    DROP COLUMN IF EXISTS goals_content,
    DROP COLUMN IF EXISTS prompt_content,
    DROP COLUMN IF EXISTS config;
`;
