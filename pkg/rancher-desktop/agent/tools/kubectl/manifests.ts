import type { ToolManifest } from '../registry';

export const kubectlToolManifests: ToolManifest[] = [
  {
    name:        'kubectl_apply',
    description: 'Apply a Kubernetes manifest file.',
    category:    'kubectl',
    schemaDef:   {
      file:      { type: 'string', description: 'Path to the manifest file' },
      namespace: { type: 'string', optional: true, description: 'Namespace to apply to' },
      dryRun:    { type: 'string', optional: true, description: 'Dry run mode: client, server, or none' },
    },
    operationTypes: ['execute', 'update'],
    loader:         () => import('./kubectl_apply'),
  },
  {
    name:        'kubectl_delete',
    description: 'Delete Kubernetes resources.',
    category:    'kubectl',
    schemaDef:   {
      resource:    { type: 'string', description: 'The resource type, e.g., pods, services' },
      name:        { type: 'string', description: 'Specific resource name' },
      namespace:   { type: 'string', optional: true, description: 'Namespace' },
      force:       { type: 'boolean', optional: true, description: 'Force deletion' },
      gracePeriod: { type: 'number', optional: true, description: 'Seconds to wait before force killing the pod' },
    },
    operationTypes: ['delete'],
    loader:         () => import('./kubectl_delete'),
  },
  {
    name:        'kubectl_describe',
    description: 'Describe Kubernetes resources.',
    category:    'kubectl',
    schemaDef:   {
      resource:  { type: 'string', description: 'The resource type, e.g., pods, services' },
      name:      { type: 'string', description: 'Specific resource name' },
      namespace: { type: 'string', optional: true, description: 'Namespace' },
    },
    operationTypes: ['read'],
    loader:         () => import('./kubectl_describe'),
  },
];
