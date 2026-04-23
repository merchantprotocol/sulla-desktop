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
    description: 'Load and run a custom function by slug. Returns the full execution trace: function metadata, runtime details, load status, inputs used, and all outputs — everything in one call.',
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
];
