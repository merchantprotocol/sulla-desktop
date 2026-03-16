import type { ToolManifest } from '../registry';

export const workspaceToolManifests: ToolManifest[] = [
  {
    name:        'create_workspace',
    description: 'Create a new workspace directory in the Lima VM.',
    category:    'workspace',
    schemaDef:   {
      name: { type: 'string', description: 'The name of the workspace to create.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./create_workspace'),
  },
  {
    name:        'delete_workspace',
    description: 'Delete an existing workspace directory in the Rancher Desktop data directory.',
    category:    'workspace',
    schemaDef:   {
      name: { type: 'string', description: 'The name of the workspace to delete.' },
    },
    operationTypes: ['delete'],
    loader:         () => import('./delete_workspace'),
  },
  {
    name:        'get_workspace_path',
    description: 'Get the relative path of a workspace in the Rancher Desktop data directory.',
    category:    'workspace',
    schemaDef:   {
      name: { type: 'string', description: 'The name of the workspace.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./get_workspace_path'),
  },
  {
    name:        'view_workspace_files',
    description: 'List files in a workspace directory in the Rancher Desktop data directory.',
    category:    'workspace',
    schemaDef:   {
      name: { type: 'string', description: 'The name of the workspace to view.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./view_workspace_files'),
  },
];
