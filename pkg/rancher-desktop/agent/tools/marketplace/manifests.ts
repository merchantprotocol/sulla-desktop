import type { ToolManifest } from '../registry';

const KINDS_DESC = 'Artifact kind. One of: skill, function, workflow, agent, recipe, integration.';

export const marketplaceToolManifests: ToolManifest[] = [
  {
    name:        'search',
    description: 'Search the Sulla Cloud marketplace for artifacts (skills, functions, workflows, agents, recipes). Filter by query, kind, and category. Falls back to the GitHub recipes catalog when the cloud API is unreachable and kind=recipe.',
    category:    'marketplace',
    schemaDef:   {
      query:    { type: 'string', optional: true, description: 'Free-text search across artifact name + description + tags.' },
      kind:     { type: 'string', optional: true, description: KINDS_DESC + ' Omit to search all kinds.' },
      category: { type: 'string', optional: true, description: 'Tag/category filter (e.g. "crm", "productivity", "analytics").' },
      limit:    { type: 'number', optional: true, description: 'Max results to return (default 25).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./search'),
  },
  {
    name:        'info',
    description: 'Get full metadata for one marketplace artifact, including manifest fields, version, publisher, tags, and any extra labels.',
    category:    'marketplace',
    schemaDef:   {
      kind: { type: 'string', description: KINDS_DESC },
      slug: { type: 'string', description: 'Artifact slug (the unique identifier within its kind).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./info'),
  },
  {
    name:        'download',
    description: 'Download a marketplace artifact and materialise it to the appropriate local directory (~/sulla/<kind>s/<slug>/). Skips if already installed unless overwrite:true.',
    category:    'marketplace',
    schemaDef:   {
      kind:      { type: 'string', description: KINDS_DESC },
      slug:      { type: 'string', description: 'Artifact slug.' },
      overwrite: { type: 'boolean', optional: true, description: 'Replace an existing local copy. Default false.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./download'),
  },
  {
    name:        'scaffold',
    description: 'Generate a new artifact directory locally with a kind-appropriate skeleton (manifest + handler / soul / compose / etc.). Pure local file generation — does not touch the marketplace.',
    category:    'marketplace',
    schemaDef:   {
      kind:        { type: 'string', description: KINDS_DESC },
      slug:        { type: 'string', description: 'Artifact slug. Must be kebab-case.' },
      name:        { type: 'string', optional: true, description: 'Display name. Defaults to the slug.' },
      description: { type: 'string', optional: true, description: 'One-line description for the manifest.' },
      runtime:     { type: 'string', optional: true, description: 'Function-only: python | node | shell. Default python.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./scaffold'),
  },
  {
    name:        'validate',
    description: 'Validate a locally-installed artifact against its kind-specific schema. Catches missing required fields, broken entrypoints, slug mismatches, and (for recipes) missing docker-compose.yml. For full workflow validation, also run sulla meta/validate_sulla_workflow.',
    category:    'marketplace',
    schemaDef:   {
      kind: { type: 'string', description: KINDS_DESC },
      slug: { type: 'string', description: 'Artifact slug.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./validate'),
  },
  {
    name:        'publish',
    description: 'Publish a locally-installed artifact to the Sulla Cloud marketplace. Bundles the manifest + companion files and POSTs them. Requires Sulla Cloud token in the vault under integration "sulla-cloud" property "api_token".',
    category:    'marketplace',
    schemaDef:   {
      kind:    { type: 'string', description: KINDS_DESC },
      slug:    { type: 'string', description: 'Artifact slug.' },
      version: { type: 'string', optional: true, description: 'Version tag for this publish (e.g. "1.0.0"). If omitted, the manifest version is used.' },
    },
    operationTypes: ['create', 'update'],
    loader:         () => import('./publish'),
  },
  {
    name:        'unpublish',
    description: 'Remove an artifact you previously published from the marketplace. Refuses without {"confirm":true}. Does NOT touch your local copy.',
    category:    'marketplace',
    schemaDef:   {
      kind:    { type: 'string', description: KINDS_DESC },
      slug:    { type: 'string', description: 'Artifact slug.' },
      confirm: { type: 'boolean', description: 'Must be true to actually unpublish — guards against accidents.' },
    },
    operationTypes: ['delete'],
    loader:         () => import('./unpublish'),
  },
  {
    name:        'list_local',
    description: 'List artifacts installed locally under ~/sulla/. Filterable by kind. Useful before publishing or to see what you have.',
    category:    'marketplace',
    schemaDef:   {
      kind: { type: 'string', optional: true, description: KINDS_DESC + ' Omit to list all kinds.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_local'),
  },
  {
    name:        'list_published',
    description: 'List artifacts the current user has published to the marketplace. Hits GET /v1/marketplace/me/published — requires Sulla Cloud token.',
    category:    'marketplace',
    schemaDef:   {},
    operationTypes: ['read'],
    loader:         () => import('./list_published'),
  },
  {
    name:        'update',
    description: 'Pull the latest version of an installed artifact from the marketplace, overwriting the local copy. Errors if not installed (use download instead).',
    category:    'marketplace',
    schemaDef:   {
      kind: { type: 'string', description: KINDS_DESC },
      slug: { type: 'string', description: 'Artifact slug.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./update'),
  },
];
