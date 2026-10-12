/** Canonical database storage for skills.
 *
 * Runtime skill resolution reads this table (SkillsRegistry). SKILL.md
 * folders under ~/sulla/resources/skills and ~/sulla/skills are an import and
 * export format only: they are copied in once and never deleted.
 *
 * body is the markdown after the frontmatter; frontmatter is the parsed YAML
 * and frontmatter_text the exact original text, so a row renders back to its
 * SKILL.md byte for byte. files holds the other files of the skill folder:
 * relative path -> text, or { encoding: 'base64', content } for binaries.
 *
 * source_hash is the hash of the content the last seeder/importer wrote. A row
 * whose live content no longer hashes to it was edited in the database and is
 * never overwritten by the built-in catalog or a folder import.
 *
 * skill_builtin_seed_ledger remembers which bundled slugs this install has
 * already had, so a built-in skill the human removes is not re-created.
 */
export const up = `
  CREATE TABLE IF NOT EXISTS skill_definitions (
    id                       TEXT PRIMARY KEY,
    slug                     TEXT NOT NULL UNIQUE,
    title                    TEXT NOT NULL,
    description              TEXT NOT NULL DEFAULT '',
    tags                     TEXT[] NOT NULL DEFAULT '{}',
    triggers                 TEXT[] NOT NULL DEFAULT '{}',
    body                     TEXT NOT NULL DEFAULT '',
    frontmatter              JSONB NOT NULL DEFAULT '{}'::jsonb,
    frontmatter_text         TEXT NOT NULL DEFAULT '',
    files                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    version                  TEXT,
    source_kind              TEXT NOT NULL DEFAULT 'user'
                             CHECK (source_kind IN ('builtin', 'user', 'marketplace', 'resources')),
    source_path              TEXT,
    source_hash              TEXT,
    enabled                  BOOLEAN NOT NULL DEFAULT true,
    deleted_at               TIMESTAMPTZ,
    content_hash             TEXT,
    marketplace_template_id  TEXT,
    marketplace_slug         TEXT,
    marketplace_version      TEXT,
    marketplace_author       TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT skill_definitions_frontmatter_object CHECK (jsonb_typeof(frontmatter) = 'object'),
    CONSTRAINT skill_definitions_files_object CHECK (jsonb_typeof(files) = 'object')
  );

  CREATE INDEX IF NOT EXISTS idx_skill_definitions_active
    ON skill_definitions (enabled) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_skill_definitions_marketplace
    ON skill_definitions (marketplace_template_id)
    WHERE marketplace_template_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS skill_builtin_seed_ledger (
    slug            TEXT PRIMARY KEY,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

export const down = `
  DROP TABLE IF EXISTS skill_builtin_seed_ledger;
  DROP TABLE IF EXISTS skill_definitions CASCADE;
`;
