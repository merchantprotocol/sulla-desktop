import type { ToolManifest } from '../registry';

/**
 * Rules tools — the DB half of the rules system that the Security Conscience
 * agent reads each turn. GLOBAL rules live as markdown files under
 * `~/sulla/rules/global/` (read via file_search/read_file); these tools
 * manage the USER-created rules stored in the `sulla_rules` table.
 */
export const rulesToolManifests: ToolManifest[] = [
  {
    name:        'list_rules',
    description: 'List active user-created rules from the rules table, most severe first then recency. These are the rules the human wants honored (security, operational, personal). Optionally filter by category or severity. The Security Conscience reads this each turn alongside the global rule files in ~/sulla/rules/global/.',
    category:    'rules',
    schemaDef:   {
      category:         { type: 'string', optional: true, description: 'Filter by category — e.g. "security", "operational", "personal". Omit to list all.' },
      severity:         { type: 'string', optional: true, description: 'Filter by severity — e.g. "critical", "high", "medium", "low". Omit to list all.' },
      limit:            { type: 'number', optional: true, description: 'Max results to return (default 100).' },
      include_disabled: { type: 'boolean', optional: true, description: 'When true, also includes rules that are toggled off (enabled=false). Default false.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_rules'),
  },
  {
    name:        'search_rules',
    description: 'Search user-created rules by keyword or phrase across title + content. The query is split into words and any rule containing ANY meaningful word matches (stopwords ignored), ranked by phrase hit then word-match count. Use before adding a new rule to check for an existing similar one, or to surface rules relevant to the current action.',
    category:    'rules',
    schemaDef:   {
      query:            { type: 'string', description: 'Search keyword or phrase — split into words, any-word ILIKE match against rule title + content.' },
      limit:            { type: 'number', optional: true, description: 'Max results to return (default 20).' },
      include_archived: { type: 'boolean', optional: true, description: 'When true, also searches archived (soft-deleted) rules. Default false.' },
      include_disabled: { type: 'boolean', optional: true, description: 'When true, also searches disabled rules. Default false.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./search_rules'),
  },
  {
    name:        'add_rule',
    description: 'Add or update a user-created rule the Security Conscience should enforce (e.g. "always confirm before touching prod", "never deploy on Fridays"). Provide an id to update a specific rule in place; otherwise a substantially similar existing rule is updated instead of creating a duplicate. Rules are never hard-deleted — use archive_rule to retire one, or set enabled:false here to pause it.',
    category:    'rules',
    schemaDef:   {
      id:       { type: 'string', optional: true, description: 'Existing rule id to update in place. Omit to add a new rule (or update a content-duplicate).' },
      title:    { type: 'string', optional: true, description: 'Short label for the rule. Defaults to the first 60 chars of content when omitted.' },
      content:  { type: 'string', description: 'The rule itself, stated clearly and imperatively — one rule per entry. Required when adding a new rule.' },
      category: { type: 'string', optional: true, default: 'security', description: 'Rule category — e.g. "security", "operational", "personal". Default "security".' },
      severity: { type: 'string', optional: true, default: 'medium', description: 'How important the rule is — "critical", "high", "medium", or "low". Default "medium".' },
      enabled:  { type: 'boolean', optional: true, description: 'Whether the rule is active. Default true. Set false to pause without archiving.' },
      source:   { type: 'string', optional: true, description: 'Optional source label (defaults to "user").' },
    },
    operationTypes: ['create', 'update'],
    loader:         () => import('./add_rule'),
  },
  {
    name:        'archive_rule',
    description: 'Archive (soft-delete) a user-created rule by its id. The record is never hard-deleted — it is marked archived=true so the history is always recoverable. To simply pause a rule without retiring it, update it via add_rule with enabled:false instead.',
    category:    'rules',
    schemaDef:   {
      id: { type: 'string', description: 'The 4-character id of the rule to archive.' },
    },
    operationTypes: ['delete'],
    loader:         () => import('./archive_rule'),
  },
];
