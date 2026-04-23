import type { ToolManifest } from '../registry';

export const workflowToolManifests: ToolManifest[] = [
  {
    name:        'execute_workflow',
    description: 'Execute a pre-registered workflow by its EXACT slug. Only call this when the slug appears verbatim in the "Available workflows" section of your system prompt — never guess a slug from the user request (e.g. do NOT invent slugs like "browser-tab-open" or "ask-date-time" unless they are explicitly listed). If no workflow matches the user intent, use exec({ command: "sulla <category>/<tool> \'...\'\" }) instead — NOT this tool. This tool CANNOT open browser tabs, run shell commands, or call sulla CLI tools.',
    category:    'meta',
    schemaDef:   {
      workflowId: { type: 'string', description: 'The workflow slug to execute. This is the filename without extension (e.g. "ask-date-time", "blog-production-pipeline"). See your system prompt for available slugs.' },
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
      workflowId:  { type: 'string', optional: true, description: 'The workflow slug (filename without extension). Used to list recent executions when executionId is not provided.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./restart_from_checkpoint'),
  },
];
