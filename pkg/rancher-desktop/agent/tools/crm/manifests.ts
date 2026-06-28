import type { ToolManifest } from '../registry';

/**
 * Dynamic CRM tools — the AI's hands on the dynamic record engine
 * (CrmSchemaService, migrations 0029–0036). With these the agent can DEFINE
 * the CRM (record types, fields, relationships, views, dashboards, widgets)
 * and OPERATE it (create/update/query/link records) entirely on demand —
 * no seeded defaults. Everything is tenant-scoped and audit-logged with undo.
 *
 * Note: this engine governs NET-NEW dynamic record types. The Sulla product's
 * existing Contact + Opportunities/Appointments/Jobs pipelines are separate.
 */
export const crmToolManifests: ToolManifest[] = [
  // ── Schema (definition) ──────────────────────────────────────────────────
  {
    name:        'list_record_types',
    description: 'List every record type in the dynamic CRM with keys + ids. Call this first to discover what exists before adding fields, creating records, or querying.',
    category:    'crm',
    schemaDef:   {},
    operationTypes: ['read'],
    loader:         () => import('./list_record_types'),
  },
  {
    name:        'create_record_type',
    description: 'Create a brand-new record type (a "table") — e.g. Property, Vehicle, Permit. Optionally seed fields inline. For NET-NEW types the product CRM does not already cover.',
    category:    'crm',
    schemaDef:   {
      key:         { type: 'string', description: 'Stable machine key, snake_case (e.g. "property").' },
      label:       { type: 'string', description: 'Singular display label (e.g. "Property").' },
      label_plural:{ type: 'string', optional: true, description: 'Plural label (defaults to label + "s").' },
      icon:        { type: 'string', optional: true, description: 'Icon name.' },
      color:       { type: 'string', optional: true, description: 'Hex accent color.' },
      description: { type: 'string', optional: true, description: 'What this type represents.' },
      fields:      { type: 'array', optional: true, description: 'Optional initial fields: [{ key, label, data_type, is_title?, is_required?, config? }].',
        items: { type: 'object' } },
    },
    operationTypes: ['create'],
    loader:         () => import('./create_record_type'),
  },
  {
    name:        'add_field',
    description: 'Add a custom field (column) to an existing record type — e.g. add "birthday" to a contact-like type. data_type ∈ text|long_text|number|currency|date|datetime|bool|select|multi_select|relation|email|phone|url|json|computed.',
    category:    'crm',
    schemaDef:   {
      record_type: { type: 'string', description: 'Record type key or id to extend.' },
      key:         { type: 'string', description: 'Field machine key, snake_case.' },
      label:       { type: 'string', optional: true, description: 'Display label.' },
      data_type:   { type: 'string', optional: true, description: 'Field data type (default "text").' },
      config:      { type: 'object', optional: true, description: 'Type-specific config (e.g. select options).' },
      is_required: { type: 'boolean', optional: true },
      is_unique:   { type: 'boolean', optional: true },
      is_title:    { type: 'boolean', optional: true, description: 'Use this field as the record title.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./add_field'),
  },
  {
    name:        'define_relationship',
    description: 'Define a typed relationship between two record types. cardinality ∈ one_to_one|one_to_many|many_to_many. Returns a relationship id for crm/link_records.',
    category:    'crm',
    schemaDef:   {
      key:         { type: 'string', description: 'Relationship machine key.' },
      from_type:   { type: 'string', description: 'Source record type key or id.' },
      to_type:     { type: 'string', description: 'Target record type key or id.' },
      cardinality: { type: 'enum', enum: ['one_to_one', 'one_to_many', 'many_to_many'], description: 'Relationship cardinality.' },
      from_label:  { type: 'string', optional: true },
      to_label:    { type: 'string', optional: true },
    },
    operationTypes: ['create'],
    loader:         () => import('./define_relationship'),
  },
  {
    name:        'archive_record_type',
    description: 'Archive (soft-delete) a record type and hide its records. Destructive — requires confirm:true. Reversible via the audit/undo log.',
    category:    'crm',
    schemaDef:   {
      id:      { type: 'string', description: 'Record type id (from list_record_types).' },
      confirm: { type: 'boolean', description: 'Must be true to proceed.' },
    },
    operationTypes: ['delete'],
    loader:         () => import('./archive_record_type'),
  },
  {
    name:        'describe_record_type',
    description: 'Return a record type\'s full field schema + all relationships. Call this before add_field, create_record, or query_records to see what already exists.',
    category:    'crm',
    schemaDef:   {
      record_type: { type: 'string', description: 'Record type key or id.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./describe_record_type'),
  },
  {
    name:        'update_field',
    description: 'Patch a field\'s label, config (e.g. select options), is_required, is_unique, or is_title. Accepts field_id directly OR { record_type, field_key } for lookup. Cannot modify system fields, key, or data_type.',
    category:    'crm',
    schemaDef:   {
      field_id:    { type: 'string', optional: true, description: 'Field id to update (preferred).' },
      record_type: { type: 'string', optional: true, description: 'Record type key or id (used with field_key).' },
      field_key:   { type: 'string', optional: true, description: 'Field key to look up within the record type.' },
      label:       { type: 'string', optional: true },
      config:      { type: 'object', optional: true, description: 'Type-specific config, e.g. select options.' },
      is_required: { type: 'boolean', optional: true },
      is_unique:   { type: 'boolean', optional: true },
      is_title:    { type: 'boolean', optional: true, description: 'Make this the title field; auto-unsets previous title.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./update_field'),
  },

  // ── Data (records) ───────────────────────────────────────────────────────
  {
    name:        'create_record',
    description: 'Create a record (row) of a given type. values is keyed by field key, e.g. { name: "Acme", phone: "555-0100" }.',
    category:    'crm',
    schemaDef:   {
      record_type: { type: 'string', description: 'Record type key or id.' },
      values:      { type: 'object', description: 'Field values keyed by field key.' },
      created_by:  { type: 'string', optional: true, description: 'Optional creator attribution.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./create_record'),
  },
  {
    name:        'update_record',
    description: 'Patch field values on an existing record. values is a partial map keyed by field key; only provided fields change.',
    category:    'crm',
    schemaDef:   {
      record_id: { type: 'string', description: 'Record id to update.' },
      values:    { type: 'object', description: 'Partial field values to set.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./update_record'),
  },
  {
    name:        'archive_record',
    description: 'Archive (soft-delete) a single record. Reversible via the audit/undo log.',
    category:    'crm',
    schemaDef:   {
      record_id: { type: 'string', description: 'Record id to archive.' },
    },
    operationTypes: ['delete'],
    loader:         () => import('./archive_record'),
  },
  {
    name:        'query_records',
    description: 'Query records of a type with field values hydrated. Optional filter (keyed by field key or core column id/title/created_at; each value is a scalar for equality or an operator object: {eq|ne|in|notIn|gt|gte|lt|lte|contains|isSet}) and sort ([{field, dir:"asc"|"desc"}]). Accepts type key or id; limit defaults to 100 (cap 500).',
    category:    'crm',
    schemaDef:   {
      record_type: { type: 'string', description: 'Record type key or id.' },
      filter:      { type: 'object', optional: true, description: 'Field/column conditions, e.g. {"stage":{"notIn":["Won","Lost"]}, "value":{"gt":5000}}.' },
      sort:        { type: 'array', optional: true, description: 'Sort specs, e.g. [{"field":"created_at","dir":"desc"}].', items: { type: 'object' } },
      limit:       { type: 'number', optional: true, description: 'Max rows (default 100, cap 500).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./query_records'),
  },
  {
    name:        'get_record',
    description: 'Get a single record by id with all field values hydrated. Use after get_linked_records returns an id and you need the full details.',
    category:    'crm',
    schemaDef:   {
      record_id: { type: 'string', description: 'Record id to fetch.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./get_record'),
  },
  {
    name:        'aggregate_records',
    description: 'Run COUNT / SUM / AVG / MIN / MAX over records of a type. Supports optional groupBy (returns one row per distinct value) and the same filter DSL as query_records. metric ∈ count|sum|avg|min|max (default count). sum/avg/min/max require a { field } key.',
    category:    'crm',
    schemaDef:   {
      record_type: { type: 'string', description: 'Record type key or id.' },
      metric:      { type: 'enum', enum: ['count', 'sum', 'avg', 'min', 'max'], optional: true, description: 'Aggregation function (default count).' },
      field:       { type: 'string', optional: true, description: 'Field key to aggregate (required for sum/avg/min/max).' },
      group_by:    { type: 'string', optional: true, description: 'Field key to group results by.' },
      filter:      { type: 'object', optional: true, description: 'Same filter DSL as query_records.' },
      limit:       { type: 'number', optional: true, description: 'Max groups to return (default 100).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./aggregate_records'),
  },
  {
    name:        'undo',
    description: 'Revert a previous CRM mutation by its undo token (from an earlier op\'s [undo:...] tag). Reverses create/update/archive/link ops; idempotent.',
    category:    'crm',
    schemaDef:   {
      undo_token: { type: 'string', description: 'The undo token returned by the op you want to revert.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./undo'),
  },
  {
    name:        'link_records',
    description: 'Link two records via a defined relationship (e.g. attach a Person to a Company).',
    category:    'crm',
    schemaDef:   {
      relationship_id: { type: 'string', description: 'Relationship id (from define_relationship).' },
      from_record_id:  { type: 'string', description: 'Source record id.' },
      to_record_id:    { type: 'string', description: 'Target record id.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./link_records'),
  },
  {
    name:        'unlink_records',
    description: 'Remove a relationship link between two records.',
    category:    'crm',
    schemaDef:   {
      relationship_id: { type: 'string', description: 'Relationship id.' },
      from_record_id:  { type: 'string', description: 'Source record id.' },
      to_record_id:    { type: 'string', description: 'Target record id.' },
    },
    operationTypes: ['delete'],
    loader:         () => import('./unlink_records'),
  },

  // ── Relationships ────────────────────────────────────────────────────────
  {
    name:        'get_linked_records',
    description: 'Traverse crm_record_links from/to a record. Returns linked record id/title/type/relationship/direction. Optional: filter by relationship_id or direction ("from"|"to"|"both", default "both").',
    category:    'crm',
    schemaDef:   {
      record_id:       { type: 'string', description: 'Record id whose links to traverse.' },
      relationship_id: { type: 'string', optional: true, description: 'Restrict to one relationship type.' },
      direction:       { type: 'enum', enum: ['from', 'to', 'both'], optional: true, description: 'Link direction (default "both").' },
      limit:           { type: 'number', optional: true, description: 'Max links to return (default 50).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./get_linked_records'),
  },

  // ── Presentation (views / dashboards / widgets) ──────────────────────────
  {
    name:        'list_views',
    description: 'List saved views for a record type (id, name, kind). Call before create_view to avoid duplicates.',
    category:    'crm',
    schemaDef:   {
      record_type: { type: 'string', description: 'Record type key or id.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_views'),
  },
  {
    name:        'list_dashboards',
    description: 'List dashboards for the tenant with widget counts. Call before create_dashboard to avoid duplicates.',
    category:    'crm',
    schemaDef:   {},
    operationTypes: ['read'],
    loader:         () => import('./list_dashboards'),
  },
  {
    name:        'create_view',
    description: 'Create a saved view for a record type. kind ∈ table|kanban|calendar|list|gallery. config carries view options (groupBy, fields, etc.).',
    category:    'crm',
    schemaDef:   {
      record_type: { type: 'string', description: 'Record type key or id.' },
      name:        { type: 'string', description: 'View name.' },
      kind:        { type: 'enum', enum: ['table', 'kanban', 'calendar', 'list', 'gallery'], description: 'View kind.' },
      config:      { type: 'object', optional: true, description: 'View-specific config.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./create_view'),
  },
  {
    name:        'create_dashboard',
    description: 'Create a dashboard (named container for widgets). Returns the dashboard id for crm/create_widget.',
    category:    'crm',
    schemaDef:   {
      key:    { type: 'string', description: 'Dashboard machine key.' },
      name:   { type: 'string', description: 'Dashboard display name.' },
      icon:   { type: 'string', optional: true },
      layout: { type: 'object', optional: true, description: 'Optional layout config.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./create_dashboard'),
  },
  {
    name:        'create_widget',
    description: 'Add a widget to a dashboard. kind ∈ stat|line|bar|funnel|list|table, driven by a record type. config carries the metric/grouping options.',
    category:    'crm',
    schemaDef:   {
      dashboard_id: { type: 'string', description: 'Dashboard id (from create_dashboard).' },
      record_type:  { type: 'string', description: 'Record type key or id the widget reports on.' },
      name:         { type: 'string', description: 'Widget title.' },
      kind:         { type: 'enum', enum: ['stat', 'line', 'bar', 'funnel', 'list', 'table'], description: 'Widget kind.' },
      config:       { type: 'object', optional: true, description: 'Widget-specific config.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./create_widget'),
  },
];
