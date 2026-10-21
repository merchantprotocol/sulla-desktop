import type { ToolManifest } from '../registry';

export const episodicToolManifests: ToolManifest[] = [
  {
    name:           'episodic_resolve',
    category:       'memory',
    operationTypes: ['read'],
    description:    'Resolve aliases to canonical active Knowledge Base nodes.',
    schemaDef:      { terms: { type: 'array', items: { type: 'string' }, description: 'Terms to resolve.' } },
    loader:         () => import('./resolve'),
  },
  {
    name:           'episodic_search',
    category:       'memory',
    operationTypes: ['read'],
    description:    'Search canonical Knowledge Base nodes without mutating recall or graph strength.',
    schemaDef:      {
      query:            { type: 'string', optional: true, description: 'Title/summary query. Empty lists recent nodes.' },
      include_archived: { type: 'boolean', optional: true, description: 'Include archived nodes.' },
      limit:            { type: 'number', optional: true, description: 'Bounded result limit.' },
    },
    loader: () => import('./search'),
  },
  {
    name:           'episodic_recall',
    category:       'memory',
    operationTypes: ['read'],
    description:    'Recall Knowledge Base nodes by query or alias. Read-only.',
    schemaDef:      {
      query:             { type: 'string', optional: true, description: 'Fallback title/summary query.' },
      terms:             { type: 'array', optional: true, items: { type: 'string' }, description: 'Fallback alias terms.' },
      limit:             { type: 'number', optional: true, description: 'Bounded result limit.' },
    },
    loader: () => import('./recall'),
  },
];
