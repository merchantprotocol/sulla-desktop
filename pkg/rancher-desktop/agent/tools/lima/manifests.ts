import type { ToolManifest } from '../registry';

export const limaToolManifests: ToolManifest[] = [
  {
    name:        'lima_create',
    description: 'Create a Lima virtual machine instance.',
    category:    'lima',
    schemaDef:   {
      template: { type: 'string', optional: true, description: 'Absolute path to YAML file' },
    },
    operationTypes: ['create'],
    loader:         () => import('./lima_create'),
  },
  {
    name:        'lima_delete',
    description: 'Delete a Lima virtual machine instance.',
    category:    'lima',
    schemaDef:   {
      instance: { type: 'string', description: 'Name of the Lima instance' },
      force:    { type: 'boolean', optional: true, description: 'Force deletion without confirmation' },
    },
    operationTypes: ['delete'],
    loader:         () => import('./lima_delete'),
  },
  {
    name:        'lima_list',
    description: 'List Lima virtual machine instances.',
    category:    'lima',
    schemaDef:   {
      json: { type: 'boolean', optional: true, description: 'Output in JSON format' },
    },
    operationTypes: ['read'],
    loader:         () => import('./lima_list'),
  },
  {
    name:        'lima_shell',
    description: 'Execute a command in a Lima virtual machine instance.',
    category:    'lima',
    schemaDef:   {
      instance: { type: 'string', description: 'Name of the Lima instance' },
      command:  { type: 'string', optional: true, description: 'Command to execute, if not provided, enters interactive shell' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./lima_shell'),
  },
  {
    name:        'lima_start',
    description: 'Start a Lima virtual machine instance.',
    category:    'lima',
    schemaDef:   {
      instance: { type: 'string', description: 'Name of the Lima instance' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./lima_start'),
  },
  {
    name:        'lima_stop',
    description: 'Stop a Lima virtual machine instance.',
    category:    'lima',
    schemaDef:   {
      instance: { type: 'string', description: 'Name of the Lima instance' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./lima_stop'),
  },
];
