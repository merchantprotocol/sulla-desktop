import type { ToolManifest } from '../registry';

export const skillsToolManifests: ToolManifest[] = [
  {
    name:        'load_skill',
    description: 'Load the FULL detailed instructions for a skill by name. Resolves from filesystem skill sources automatically. Do NOT use exec/cat to read skill files — always use this tool. Call after file_search confirms relevance.',
    category:    'skills',
    schemaDef:   {
      skill_name: { type: 'string', description: 'The name or slug of the skill to load (e.g. "marketing-plan", "software-development").' },
    },
    operationTypes: ['read'],
    loader:         () => import('./load_skill'),
  },
];
