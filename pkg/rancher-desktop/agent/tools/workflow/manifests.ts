import type { ToolManifest } from '../registry';

export const workflowToolManifests: ToolManifest[] = [
  {
    name: 'execute_workflow',
    description: 'Execute a specific workflow by its slug/ID. Available workflows are listed in your system prompt.',
    category: 'meta',
    schemaDef: {
      workflowId: { type: 'string', description: 'The workflow slug/ID to execute.' },
      message: { type: 'string', optional: true, description: 'Message or payload to pass to the workflow. Defaults to the current user message.' },
    },
    operationTypes: ['execute'],
    loader: () => import('./execute_workflow'),
  },
];
