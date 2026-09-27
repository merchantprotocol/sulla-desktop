import type { ToolManifest } from '../registry';

const KINDS_DESC = 'Artifact kind. One of: skill, function, routine (alias: workflow), recipe, integration. "agent" is local-only (scaffold/validate/list_local).';

export const marketplaceToolManifests: ToolManifest[] = [
  {
    name:        'search',
    description: 'Search the Sulla Marketplace (skills, functions, routines, recipes, integrations). Filter by free text, kind, and category. Shows version, author, download count, and whether each listing is already installed or has an update. Works without signing in.',
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
    description: 'Full details for one marketplace listing by kind + slug: template id, version, author, category, tags, downloads, manifest metadata and kind summary, and local install status.',
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
    description: 'Install a marketplace listing into its local directory (~/sulla/<kind>s/<dir>/) using the same safe installer as the Marketplace tab. No-op if already installed; pass overwrite:true to reinstall/replace in place (rolled back on failure).',
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
    description: 'Submit a local artifact (~/sulla/<kind>s/<slug>/) to the Sulla Marketplace — same pipeline as the Library Publish button. Secrets and junk (.env, .git, node_modules, keys) are never uploaded. The listing is pending until an admin approves it. Requires a Sulla Cloud session (sign in from the app).',
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
    description: 'Take down your own marketplace submission for kind + slug: approved listings are withdrawn (kept in your submissions as rejected), pending ones are deleted. Refuses without {"confirm":true}. Does NOT touch your local copy. Requires a Sulla Cloud session.',
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
    description: 'List everything you have submitted to the marketplace with its review status (pending / live / rejected), download count, and reviewer notes. Requires a Sulla Cloud session.',
    category:    'marketplace',
    schemaDef:   {},
    operationTypes: ['read'],
    loader:         () => import('./list_published'),
  },
  {
    name:        'update',
    description: 'Update an installed marketplace artifact to the latest version, replacing the local copy in place (restored if the update fails). Errors if it isn\'t installed from the marketplace (use download instead).',
    category:    'marketplace',
    schemaDef:   {
      kind: { type: 'string', description: KINDS_DESC },
      slug: { type: 'string', description: 'Artifact slug.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./update'),
  },
  {
    name:        'diff',
    description: 'Show files only in the marketplace, only local, or differing between your installed copy and the latest marketplace version. Read-only. Use before marketplace/update, which replaces the folder.',
    category:    'marketplace',
    schemaDef:   {
      kind: { type: 'string', description: KINDS_DESC },
      slug: { type: 'string', description: 'Artifact slug.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./diff'),
  },
];
