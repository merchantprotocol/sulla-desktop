import type { ToolManifest } from '../registry';

export const workflowToolManifests: ToolManifest[] = [
  {
    name: 'list_workflows',
    description: 'List available workflows for the current trigger type (or a specific trigger type). Returns workflow name, slug, and description so you can decide which workflow to execute.',
    category: 'workflow',
    schemaDef: {
      triggerType: {
        type: 'enum',
        optional: true,
        enum: ['calendar', 'chat-app', 'heartbeat', 'sulla-desktop', 'workbench', 'chat-completions'],
        description: 'Filter workflows by trigger type. If omitted, uses the trigger type from the current agent state.',
      },
    },
    operationTypes: ['read'],
    loader: () => import('./list_workflows'),
  },
  {
    name: 'execute_workflow',
    description: 'Execute a specific workflow by its slug/ID. Use list_workflows first to discover available workflows.',
    category: 'workflow',
    schemaDef: {
      workflowId: { type: 'string', description: 'The workflow slug/ID to execute (from list_workflows).' },
      message: { type: 'string', optional: true, description: 'Message or payload to pass to the workflow. Defaults to the current user message.' },
    },
    operationTypes: ['execute'],
    loader: () => import('./execute_workflow'),
  },
];
