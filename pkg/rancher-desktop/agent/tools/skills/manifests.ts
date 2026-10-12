import type { ToolManifest } from '../registry';

/**
 * Skills tools — manage the skills stored in the skill_definitions table.
 * The database is the only runtime source for skills; SKILL.md folders are
 * import/export only (marketplace bundles, ~/sulla/skills).
 */
export const skillsToolManifests: ToolManifest[] = [
  {
    name:        'skill_list',
    description: 'List the skills in the database (slug, title, source, enabled, triggers). Pass query to search titles, descriptions, tags, triggers and bodies. Disabled and deleted skills are hidden unless asked for.',
    category:    'skills',
    schemaDef:   {
      query:            { type: 'string', optional: true, description: 'Search words. Omit to list every skill.' },
      include_disabled: { type: 'boolean', optional: true, description: 'Also list disabled skills.' },
      include_deleted:  { type: 'boolean', optional: true, description: 'Also list soft-deleted skills.' },
      limit:            { type: 'number', optional: true, description: 'Max rows (default 100).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./skill_list'),
  },
  {
    name:        'skill_get',
    description: 'Load one skill from the database: its full SKILL.md (frontmatter + body) and the list of its extra files. Set materialize:true to also write the skill folder to ~/sulla/cache/skills/<slug>/ and get that path back, for skills whose scripts or html must run from disk. Set include_files:true to inline the extra files.',
    category:    'skills',
    schemaDef:   {
      slug:          { type: 'string', description: 'Skill slug, e.g. "playbook-software-feature".' },
      materialize:   { type: 'boolean', optional: true, description: 'Write the skill folder to ~/sulla/cache/skills/<slug>/ and return the path.' },
      include_files: { type: 'boolean', optional: true, description: 'Inline the text of the extra files.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./skill_get'),
  },
  {
    name:        'skill_save',
    description: 'Create or update a skill in the database from SKILL.md text: a YAML frontmatter block (slug, title, tags, triggers, ...) followed by the markdown body. Optionally pass files (relative path -> text) to store extra files such as templates/ or scripts/. Saving over a built-in or imported skill marks it as edited, so app updates and folder imports never overwrite it. Saving a deleted slug restores it.',
    category:    'skills',
    schemaDef:   {
      markdown: { type: 'string', description: 'The full SKILL.md text, starting with the --- frontmatter block.' },
      slug:     { type: 'string', optional: true, description: 'Expected slug. Must match the frontmatter slug when both are given.' },
      files:    { type: 'object', optional: true, description: 'Extra files, relative path -> text content. Replaces the stored files when given; omit to keep them.' },
    },
    operationTypes: ['create', 'update'],
    loader:         () => import('./skill_save'),
  },
  {
    name:        'skill_disable',
    description: 'Disable, re-enable, or soft-delete a skill in the database. Disabled and deleted skills stop showing up for agents; nothing is ever hard-deleted, and a deleted slug is never re-imported from folders or re-seeded by app updates. skill_save restores a deleted skill.',
    category:    'skills',
    schemaDef:   {
      slug:    { type: 'string', description: 'Skill slug.' },
      action:  { type: 'string', optional: true, description: '"disable" (default), "enable", or "delete" (soft).' },
    },
    operationTypes: ['update', 'delete'],
    loader:         () => import('./skill_disable'),
  },
];
