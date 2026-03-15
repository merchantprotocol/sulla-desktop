import type { ToolManifest } from '../registry';

export const projectsToolManifests: ToolManifest[] = [
  {
    name:        'load_project',
    description: 'Load the FULL PROJECT.md content (PRD) for a project. Call after meta_search confirms relevance.',
    category:    'projects',
    schemaDef:   {
      project_name: { type: 'string', description: 'The slug or folder name of the project to load.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./load_project'),
  },
];
