/** Database-only storage for marketplace artifacts and atomic packages. */
export const up = `
  CREATE TABLE IF NOT EXISTS function_definitions (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    manifest JSONB NOT NULL,
    runtime TEXT NOT NULL CHECK (runtime IN ('python', 'node', 'shell', 'agent')),
    files JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_kind TEXT NOT NULL DEFAULT 'user' CHECK (source_kind IN ('user', 'marketplace')),
    version TEXT,
    user_edited BOOLEAN NOT NULL DEFAULT false,
    marketplace_template_id TEXT,
    marketplace_author TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS integration_definitions (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    manifest JSONB NOT NULL,
    files JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_kind TEXT NOT NULL DEFAULT 'user' CHECK (source_kind IN ('user', 'marketplace')),
    version TEXT,
    user_edited BOOLEAN NOT NULL DEFAULT false,
    marketplace_template_id TEXT,
    marketplace_author TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS recipe_definitions (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    manifest JSONB NOT NULL,
    compose TEXT NOT NULL,
    files JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_kind TEXT NOT NULL DEFAULT 'user' CHECK (source_kind IN ('user', 'marketplace')),
    version TEXT,
    user_edited BOOLEAN NOT NULL DEFAULT false,
    marketplace_template_id TEXT,
    marketplace_author TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  ALTER TABLE workflows
    ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'user'
      CHECK (source_kind IN ('user', 'marketplace', 'system')),
    ADD COLUMN IF NOT EXISTS user_edited BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS marketplace_template_id TEXT,
    ADD COLUMN IF NOT EXISTS marketplace_author TEXT;

  ALTER TABLE agent_definitions
    ADD COLUMN IF NOT EXISTS user_edited BOOLEAN NOT NULL DEFAULT false;

  CREATE TABLE IF NOT EXISTS installed_packages (
    slug TEXT PRIMARY KEY,
    template_id TEXT NOT NULL UNIQUE,
    version TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    manifest JSONB NOT NULL,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS installed_package_items (
    package_slug TEXT NOT NULL REFERENCES installed_packages(slug) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('agent', 'skill', 'routine', 'function', 'integration', 'recipe')),
    item_slug TEXT NOT NULL,
    installed_template_id TEXT,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (package_slug, kind, item_slug)
  );

  CREATE INDEX IF NOT EXISTS idx_function_definitions_marketplace ON function_definitions (marketplace_template_id);
  CREATE INDEX IF NOT EXISTS idx_integration_definitions_marketplace ON integration_definitions (marketplace_template_id);
  CREATE INDEX IF NOT EXISTS idx_recipe_definitions_marketplace ON recipe_definitions (marketplace_template_id);
  CREATE INDEX IF NOT EXISTS idx_workflows_marketplace ON workflows (marketplace_template_id);
  CREATE INDEX IF NOT EXISTS idx_installed_package_items_artifact ON installed_package_items (kind, item_slug);
`;

export const down = `
  DROP TABLE IF EXISTS installed_package_items;
  DROP TABLE IF EXISTS installed_packages;
  DROP TABLE IF EXISTS recipe_definitions;
  DROP TABLE IF EXISTS integration_definitions;
  DROP TABLE IF EXISTS function_definitions;
  ALTER TABLE workflows
    DROP COLUMN IF EXISTS marketplace_author,
    DROP COLUMN IF EXISTS marketplace_template_id,
    DROP COLUMN IF EXISTS user_edited,
    DROP COLUMN IF EXISTS source_kind;
  ALTER TABLE agent_definitions DROP COLUMN IF EXISTS user_edited;
`;
