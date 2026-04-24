import type { ToolManifest } from '../registry';

export const functionToolManifests: ToolManifest[] = [
  {
    name:        'function_list',
    description: 'List all custom functions installed in ~/sulla/functions/ — shows slug, name, runtime, entrypoint, inputs, and outputs for each.',
    category:    'function',
    schemaDef:   {},
    operationTypes: ['read'],
    loader:         () => import('./function_list'),
  },
  {
    name:        'function_run',
    description: 'Load and run a custom function by slug. Returns the full execution trace: function metadata, runtime details, load status, inputs used, and all outputs — everything in one call. Every invocation is logged to the `function_runs` table — query via function/runs.',
    category:    'function',
    schemaDef:   {
      slug: {
        type:        'string',
        description: 'The function slug (directory name under ~/sulla/functions/).',
      },
      inputs: {
        type:        'object',
        optional:    true,
        description: 'Input key/value pairs for the function. Omit to use function defaults.',
      },
      version: {
        type:        'string',
        optional:    true,
        description: 'Version string for the runtime loader. Defaults to "1.0.0".',
      },
    },
    operationTypes: ['execute'],
    loader:         () => import('./function_run'),
  },
  {
    name:        'function_runs',
    description: 'Query the function_run history. Every function_run call writes a row with slug, runtime, inputs/outputs, success, error_stage, duration. Filter by slug, only_failures, since (ISO timestamp). Default 50 rows; pass verbose:true to see inputs/outputs.',
    category:    'function',
    schemaDef:   {
      slug:          { type: 'string',  optional: true, description: 'Filter to one function slug.' },
      only_failures: { type: 'boolean', optional: true, description: 'If true, return only runs where success=false.' },
      since:         { type: 'string',  optional: true, description: 'ISO-8601 timestamp — only runs at/after this time.' },
      limit:         { type: 'number',  optional: true, description: 'Max rows (default 50, cap 200).' },
      verbose:       { type: 'boolean', optional: true, description: 'Include full inputs + outputs in output.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./function_runs'),
  },
];
