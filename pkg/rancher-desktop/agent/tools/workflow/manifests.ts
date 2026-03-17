import type { ToolManifest } from '../registry';

export const workflowToolManifests: ToolManifest[] = [
  {
    name:        'execute_workflow',
    description: 'Execute a specific workflow by its slug/ID. Available workflows are listed in your system prompt.',
    category:    'meta',
    schemaDef:   {
      workflowId: { type: 'string', description: 'The workflow slug/ID to execute.' },
      message:    { type: 'string', optional: true, description: 'Message or payload to pass to the workflow. Defaults to the current user message.' },
      resume:     { type: 'boolean', optional: true, description: 'Resume from the last checkpoint instead of starting fresh. Only set to true when the user explicitly asks to resume a previous run. Default: false.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./execute_workflow'),
  },
  {
    name:        'validate_sulla_workflow',
    description: 'Validate a Sulla workflow YAML file for structural correctness before it goes live. Checks top-level schema, node types, subtype/category mapping, required config fields, edge format, trigger presence, and reachability. Use this EVERY time you create or edit a Sulla workflow YAML.',
    category:    'meta',
    schemaDef:   {
      filePath: { type: 'string', optional: true, description: 'Absolute path (or ~/sulla/workflows/...) to the workflow YAML file to validate.' },
      yaml:     { type: 'string', optional: true, description: 'Inline YAML string to validate (alternative to filePath).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./validate_sulla_workflow'),
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
