import type { ToolManifest } from '../registry';

export const skillsToolManifests: ToolManifest[] = [
  {
    name: 'search_skills',
    description: 'Search available skills by description or tag. Use when you intend to load or create a skill.',
    category: 'meta',
    schemaDef: {
      query: { type: 'string', description: 'Search query — keywords to match against skill names, descriptions, and tags.' },
    },
    operationTypes: ['read'],
    loader: () => import('./search_skills'),
  },
  {
    name: 'load_skill',
    description: 'Load the FULL detailed instructions for a skill by name. Resolves from native (built-in), database, or filesystem sources automatically. Do NOT use exec/cat to read skill files — always use this tool. Call after search_skills confirms relevance.',
    category: 'meta',
    schemaDef: {
      skill_name: { type: 'string', description: 'The name or slug of the skill to load (e.g. "marketing-plan", "software-development").' },
    },
    operationTypes: ['read'],
    loader: () => import('./load_skill'),
  },
  {
    name: 'create_skill',
    description: 'Create or update a new skill folder + SKILL.md. Use after your game plan is approved.',
    category: 'skills',
    schemaDef: {
      skill_name: { type: 'string', description: 'The folder name for the skill (used as identifier).' },
      content: { type: 'string', description: 'Full SKILL.md content including YAML frontmatter and markdown body.' },
    },
    operationTypes: ['create'],
    loader: () => import('./create_skill'),
  },
];
