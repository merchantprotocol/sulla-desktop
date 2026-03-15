import type { ToolManifest } from '../registry';

export const pgToolManifests: ToolManifest[] = [
  {
    name:        'pg_count',
    description: 'Execute a PostgreSQL count query and return the count.',
    category:    'pg',
    schemaDef:   {
      sql:    { type: 'string', description: 'The SQL count query to execute' },
      params: { type: 'array', items: { type: 'string' }, optional: true, description: 'Parameters for the query' },
    },
    operationTypes: ['read'],
    loader:         () => import('./pg_count'),
  },
  {
    name:        'pg_execute',
    description: 'Execute a PostgreSQL statement and return execution results.',
    category:    'pg',
    schemaDef:   {
      sql:       { type: 'string', optional: true, description: 'The SQL statement to execute' },
      query:     { type: 'string', optional: true, description: 'Alias for sql' },
      statement: { type: 'string', optional: true, description: 'Alias for sql' },
      params:    { type: 'array', items: { type: 'string' }, optional: true, description: 'Parameters for the statement' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./pg_execute'),
  },
  {
    name:        'pg_query',
    description: 'Execute a PostgreSQL query and return results.',
    category:    'pg',
    schemaDef:   {
      sql:       { type: 'string', optional: true, description: 'The SQL query to execute' },
      query:     { type: 'string', optional: true, description: 'Alias for sql' },
      statement: { type: 'string', optional: true, description: 'Alias for sql' },
      params:    { type: 'array', items: { type: 'string' }, optional: true, description: 'Parameters for the query' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./pg_query'),
  },
  {
    name:        'pg_queryall',
    description: 'Execute a PostgreSQL query and return all result rows.',
    category:    'pg',
    schemaDef:   {
      sql:    { type: 'string', description: 'The SQL query to execute' },
      params: { type: 'array', items: { type: 'string' }, optional: true, description: 'Parameters for the query' },
    },
    operationTypes: ['read'],
    loader:         () => import('./pg_queryall'),
  },
  {
    name:        'pg_queryone',
    description: 'Execute a PostgreSQL query and return the first result row.',
    category:    'pg',
    schemaDef:   {
      sql:    { type: 'string', description: 'The SQL query to execute' },
      params: { type: 'array', items: { type: 'string' }, optional: true, description: 'Parameters for the query' },
    },
    operationTypes: ['read'],
    loader:         () => import('./pg_queryone'),
  },
  {
    name:        'pg_transaction',
    description: 'Execute multiple PostgreSQL statements in a transaction.',
    category:    'pg',
    schemaDef:   {
      sql: { type: 'string', description: 'SQL statements separated by semicolons to execute in a transaction' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./pg_transaction'),
  },
];
