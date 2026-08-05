import type { ToolManifest } from '../registry';

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
    description: 'Recall associated episodic context from the knowledge graph using alias resolution and ≤2-hop spreading activation.',
    category:    'memory',
    schemaDef:   {
      terms:      { type: 'array', items: { type: 'string' }, description: 'Anchor terms for recall.' },
      query_text: { type: 'string', optional: true, description: 'Optional original user query text.' },
      limit:      { type: 'number', optional: true, description: 'Maximum recalled nodes to return.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./episodic_recall'),
  },
  {
    name:        'episodic_write_episode',
    description: 'Persist ONE completed episode to the knowledge graph. Call once, at the end of encoding. Writes are atomic: the project anchor and entities are resolved and reused if they already exist (no duplicates); the event node plus lessons/blockers/new entities are created; every observed surface form becomes an alias; edges are created (event belongs_to project, lessons learned_from event, blockers blocked_by event, entities mentioned_in event) so no node is orphaned; and co-occurring pairs are Hebbian-reinforced. Provide the richest encoding you can — this is how the graph grows.',
    category:    'memory',
    schemaDef:   {
      source:  { type: 'string', optional: true, description: "Episode origin: 'chat', 'heartbeat', or 'sub-agent'." },
      project: { type: 'object', optional: true, description: 'The project/epic this episode belongs to: { title, aliases?: string[] }. Resolved+reused if it already exists.' },
      event:   { type: 'object', description: 'REQUIRED. The "what happened" node: { title, summary, detail?, aliases?: string[] }. Summary is written to be read cold months later.' },
      lessons: { type: 'array', optional: true, items: { type: 'object' }, description: 'What we learned: [{ title, summary, detail? }] — linked learned_from the event.' },
      blockers: { type: 'array', optional: true, items: { type: 'object' }, description: 'Blockers hit: [{ title, summary }] — linked blocked_by the event.' },
      entities: { type: 'array', optional: true, items: { type: 'object' }, description: 'Entities/concepts/people/services seen: [{ title, aliases?: string[], node_type? }] — resolved+reused, linked mentioned_in the event.' },
      reinforcePairs: { type: 'array', optional: true, items: { type: 'array', items: { type: 'string' } }, description: 'Pairs of surface forms that co-occurred, e.g. [["Sulla Desktop","episodic memory"]] — each pair gets a reinforced related_to edge.' },
    },
    operationTypes: ['create', 'update'],
    loader:         () => import('./episodic_write_episode'),
  },
];
