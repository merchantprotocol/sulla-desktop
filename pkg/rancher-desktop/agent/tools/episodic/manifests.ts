import type { ToolManifest } from '../registry';

const ITEM_FIELDS = {
  item_kind:         { type: 'string', description: 'Projects target kind: project, epic, or task.' },
  item_id:           { type: 'string', description: 'Projects item id.' },
  knowledge_node_id: { type: 'string', description: 'Canonical or merged Knowledge Base node id.' },
};

const MUTATION_FIELDS = {
  ...ITEM_FIELDS,
  relation_type: { type: 'string', optional: true, description: 'Soft relation vocabulary; defaults to related_to.' },
  note:          { type: 'string', optional: true, description: 'Optional association note.' },
  actor:         { type: 'string', optional: true, description: 'Agent/user attribution.' },
  source:        { type: 'string', optional: true, description: 'Mutation source; defaults to tool.' },
};

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
    description:    'Recall Knowledge Base nodes with direct then inherited Projects scope before ordinary fallback. Read-only.',
    schemaDef:      {
      query:             { type: 'string', optional: true, description: 'Fallback title/summary query.' },
      terms:             { type: 'array', optional: true, items: { type: 'string' }, description: 'Fallback alias terms.' },
      project_id:        { type: 'string', optional: true, description: 'Project scope.' },
      epic_id:           { type: 'string', optional: true, description: 'Epic scope.' },
      task_id:           { type: 'string', optional: true, description: 'Task scope.' },
      include_inherited: { type: 'boolean', optional: true, description: 'Include parent associations; default true.' },
      limit:             { type: 'number', optional: true, description: 'Bounded result limit.' },
    },
    loader: () => import('./recall'),
  },
  {
    name:           'episodic_link_project_item',
    category:       'memory',
    operationTypes: ['create', 'update'],
    description:    'Attach a Knowledge Base node to exactly one Projects item through the shared association model.',
    schemaDef:      MUTATION_FIELDS,
    loader:         () => import('./link_project_item'),
  },
  {
    name:           'episodic_unlink_project_item',
    category:       'memory',
    operationTypes: ['update'],
    description:    'Soft-unlink one direct Knowledge Base to Projects association.',
    schemaDef:      MUTATION_FIELDS,
    loader:         () => import('./unlink_project_item'),
  },
  {
    name:           'episodic_list_linked_project_items',
    category:       'memory',
    operationTypes: ['read'],
    description:    'Reverse lookup Projects items directly associated with a Knowledge Base node, with ancestry.',
    schemaDef:      {
      knowledge_node_id: ITEM_FIELDS.knowledge_node_id,
      relation_type:     { type: 'string', optional: true, description: 'Optional relation filter.' },
      include_archived:  { type: 'boolean', optional: true, description: 'Include archived links/items.' },
      limit:             { type: 'number', optional: true, description: 'Bounded result limit.' },
    },
    loader: () => import('./list_linked_project_items'),
  },
];
