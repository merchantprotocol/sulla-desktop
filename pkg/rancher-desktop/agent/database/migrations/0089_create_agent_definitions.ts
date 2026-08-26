/** Canonical database storage for marketplace-backed agent definitions.
 *
 * Runtime agent resolution reads this table. The legacy
 * ~/sulla/resources/agents/<slug>/ bundle remains an import/export format only.
 */
export const up = `
  CREATE TABLE IF NOT EXISTS agent_definitions (
    id                    TEXT PRIMARY KEY,
    slug                  TEXT NOT NULL UNIQUE,
    name                  TEXT NOT NULL,
    description           TEXT NOT NULL DEFAULT '',
    system_prompt         TEXT NOT NULL DEFAULT '',
    soul_content          TEXT NOT NULL DEFAULT '',
    allowed_tools         TEXT[] NOT NULL DEFAULT '{}',
    skill_refs            TEXT[] NOT NULL DEFAULT '{}',
    routine_refs          TEXT[] NOT NULL DEFAULT '{}',
    model_priority        JSONB NOT NULL DEFAULT '[]'::jsonb,
    version               TEXT,
    status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'production', 'archive')),
    enabled               BOOLEAN NOT NULL DEFAULT true,
    source_template_slug  TEXT,
    content_hash          TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT agent_definitions_model_priority_array
      CHECK (jsonb_typeof(model_priority) = 'array')
  );

  CREATE INDEX IF NOT EXISTS idx_agent_definitions_status
    ON agent_definitions (status);
  CREATE INDEX IF NOT EXISTS idx_agent_definitions_enabled
    ON agent_definitions (enabled);
`;

export const down = `
  DROP TABLE IF EXISTS agent_definitions CASCADE;
`;
