import type { ToolManifest } from '../registry';

const notImplemented = (issue: '#517' | '#518') => () => Promise.reject(new Error(`not implemented until ${ issue }`));

export const episodicToolManifests: ToolManifest[] = [
  {
    name:        'episodic_resolve',
    description: 'Resolve surface-form terms to knowledge graph nodes using exact normalized aliases and pg_trgm fuzzy matching.',
    category:    'memory',
    schemaDef:   {
      terms: {
        type:        'array',
        description: 'Entity, event, or lesson terms to resolve against node aliases.',
        items:       { type: 'string' },
      },
    },
    operationTypes: ['read'],
    loader:         () => import('./episodic_resolve'),
  },
  {
    name:        'episodic_recall',
    description: 'Recall associated episodic context from the knowledge graph. Declared for Phase 2.',
    category:    'memory',
    schemaDef:   {
      terms:      { type: 'array', items: { type: 'string' }, description: 'Anchor terms for recall.' },
      query_text: { type: 'string', optional: true, description: 'Optional original user query text.' },
      limit:      { type: 'number', optional: true, description: 'Maximum recalled nodes to return.' },
    },
    operationTypes: ['read'],
    loader:         notImplemented('#517'),
  },
  {
    name:        'episodic_write_episode',
    description: 'Write encoded episode nodes, aliases, and links to episodic memory. Declared for Phase 3.',
    category:    'memory',
    schemaDef:   {
      nodes:    { type: 'array', optional: true, items: { type: 'object' }, description: 'Encoded knowledge nodes.' },
      links:    { type: 'array', optional: true, items: { type: 'object' }, description: 'Encoded node links.' },
      resolved: { type: 'array', optional: true, items: { type: 'object' }, description: 'Previously resolved node matches.' },
    },
    operationTypes: ['create', 'update'],
    loader:         notImplemented('#518'),
  },
];
