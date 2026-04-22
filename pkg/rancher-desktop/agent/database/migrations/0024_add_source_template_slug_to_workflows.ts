export const up = `
  ALTER TABLE workflows
    ADD COLUMN IF NOT EXISTS source_template_slug VARCHAR(255) NULL;

  CREATE INDEX IF NOT EXISTS idx_workflows_source_template_slug
    ON workflows(source_template_slug);
`;

export const down = `
  DROP INDEX IF EXISTS idx_workflows_source_template_slug;
  ALTER TABLE workflows DROP COLUMN IF EXISTS source_template_slug;
`;
