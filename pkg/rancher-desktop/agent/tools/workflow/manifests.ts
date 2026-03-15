import type { ToolManifest } from '../registry';

export const workflowToolManifests: ToolManifest[] = [
  {
    name:        'execute_workflow',
    description: 'Execute a specific workflow by its slug/ID. Available workflows are listed in your system prompt.',
    category:    'meta',
    schemaDef:   {
      workflowId: { type: 'string', description: 'The workflow slug/ID to execute.' },
      message:    { type: 'string', optional: true, description: 'Message or payload to pass to the workflow. Defaults to the current user message.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./execute_workflow'),
  },
  {
    name:        'restart_from_checkpoint',
    description: 'Restart a workflow execution from a specific node checkpoint. Use workflowId alone to list recent executions, executionId alone to list checkpoints, or executionId + nodeId to restart from that node.',
    category:    'meta',
    schemaDef:   {
      executionId: { type: 'string', optional: true, description: 'The execution ID to restart from. Omit to list recent executions for a workflow.' },
      nodeId:      { type: 'string', optional: true, description: 'The node ID to restart from. The workflow will re-execute this node and everything after it.' },
      workflowId:  { type: 'string', optional: true, description: 'The workflow ID. Used to list recent executions when executionId is not provided.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./restart_from_checkpoint'),
  },
];
