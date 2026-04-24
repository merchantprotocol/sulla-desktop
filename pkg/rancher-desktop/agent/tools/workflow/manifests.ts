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
    name:        'import_workflow',
    description: 'Import a local routine.yaml file into the workflows database so it can be executed. Reads from ~/sulla/routines/<slug>/routine.yaml and upserts into the DB. Use this after writing or editing a workflow YAML to make it available to execute_workflow.',
    category:    'workflow',
    schemaDef:   {
      slug:   { type: 'string', description: 'The workflow slug — directory name under ~/sulla/routines/ containing a routine.yaml.' },
      status: { type: 'string', optional: true, description: 'Workflow status: draft | production | archive. Defaults to "production".' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./import_workflow'),
  },
  {
    name:        'display_workflow',
    description: 'Surface a saved routine as a workflow artifact in the chat sidebar. Reads ~/sulla/routines/<slug>/routine.yaml and publishes the full document so the frontend opens (or updates in place) a workflow artifact pane next to the conversation. Use this AFTER import_workflow whenever the user should see the routine being built, and re-run it after each material edit to keep the sidebar card in sync. Artifact is deduped by workflow name — repeat calls for the same slug update one card, not many.',
    category:    'workflow',
    schemaDef:   {
      slug: { type: 'string', description: 'The routine slug — directory name under ~/sulla/routines/ containing a routine.yaml. Must match the slug used in marketplace/scaffold and workflow/import_workflow.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./display_workflow'),
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
  {
    name:        'stop_workflow',
    description: 'Request a running workflow to stop. Cooperative — writes a Redis flag the PlaybookController checks at each frontier tick, so the running orchestrator honors it on its next step. If the orchestrator is blocked on a long-running sub-agent or LLM call, the abort takes effect when that call returns. For immediate hard-kill, restart Sulla Desktop.',
    category:    'meta',
    schemaDef:   {
      executionId: { type: 'string', description: 'The execution ID (wfp-... from execute_workflow) to stop.' },
      reason:      { type: 'string', optional: true, description: 'Optional short reason shown in the abort event. Default: "Stopped by user request".' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./stop_workflow'),
  },
  {
    name:        'pause_workflow',
    description: 'Pause a running workflow without releasing it. Cooperative — PlaybookController checks a Redis flag at each frontier tick and halts frontier advance. In-flight sub-agent work is NOT cancelled. Resume with resume_workflow.',
    category:    'meta',
    schemaDef:   {
      executionId: { type: 'string', description: 'Execution ID to pause.' },
      reason:      { type: 'string', optional: true, description: 'Optional reason.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./pause_workflow'),
  },
  {
    name:        'resume_workflow',
    description: 'Resume a workflow paused with pause_workflow by clearing its pause flag. The orchestrator resumes frontier advance on its next tick.',
    category:    'meta',
    schemaDef:   {
      executionId: { type: 'string', description: 'Execution ID to resume.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./resume_workflow'),
  },
  {
    name:        'dry_run_workflow',
    description: 'Walk a workflow statically — parse YAML, traverse from triggers, report execution order and any orphans or runtime-ambiguous branches. Does NOT execute any node (no side effects). Use to verify routing before committing to a live run.',
    category:    'meta',
    schemaDef:   {
      slug:     { type: 'string', optional: true, description: 'Routine or flat-workflow slug. Exactly one of slug or filePath required.' },
      filePath: { type: 'string', optional: true, description: 'Absolute path to a routine.yaml / workflow yaml.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./dry_run_workflow'),
  },
];
