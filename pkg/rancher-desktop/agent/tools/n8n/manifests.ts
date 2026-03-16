import type { ToolManifest } from '../registry';

export const n8nToolManifests: ToolManifest[] = [
  {
    name:        'diagnose_webhook',
    description: 'Diagnose webhook readiness for a workflow by checking DB registration, workflow active state, endpoint response, and relevant n8n logs.',
    category:    'n8n',
    schemaDef:   {
      workflowId:        { type: 'string', description: 'Workflow ID to diagnose.' },
      container:         { type: 'string', optional: true, default: 'sulla_n8n', description: 'Docker container name for n8n logs.' },
      endpointTimeoutMs: { type: 'number', optional: true, default: 15000, description: 'Timeout for endpoint probe request.' },
    },
    operationTypes: ['read', 'execute'],
    loader:         () => import('./diagnose_webhook'),
  },
  {
    name:        'patch_workflow',
    description: 'Apply node and connection add/update/remove operations to an n8n workflow in one atomic update.',
    category:    'n8n',
    schemaDef:   {
      workflowId: { type: 'string', description: 'Workflow ID' },
      operations: {
        type:        'array',
        description: 'Patch operations applied in sequence, then persisted in one atomic update. Node ops: target=node with op=add/update/remove. Connection ops: target=connection with op=add/remove, source (or connectionSource), connectionTarget, sourceOutputIndex/sourceIndex, targetInputIndex/targetIndex.',
        items:       {
          type:       'object',
          properties: {
            target:            { type: 'enum', enum: ['node', 'connection'], description: 'Operation target.' },
            op:                { type: 'enum', enum: ['add', 'update', 'remove'], description: 'Operation verb.' },
            node:              { type: 'object', description: 'For node add: full node object. For node update: optional full node object to replace/update complex nested fields reliably.' },
            nodeId:            { type: 'string', description: 'For node update/remove: node ID selector.' },
            nodeName:          { type: 'string', description: 'For node update/remove: node name selector.' },
            patch:             { type: 'object', description: 'For node update: partial node patch object.' },
            source:            { type: 'string', description: 'For connection add/remove: source node name (aliases: connectionSource, sourceNodeName).' },
            connectionTarget:  { type: 'string', description: 'For connection add/remove: destination node name. You can also pass an object { node, index }.' },
            sourceOutputIndex: { type: 'number', description: 'For connection add/remove: source output index (alias: sourceIndex). Default 0.' },
            targetInputIndex:  { type: 'number', description: 'For connection add/remove: destination input index (alias: targetIndex). Default 0.' },
          },
        },
      },
    },
    operationTypes: ['update'],
    loader:         () => import('./patch_workflow'),
  },
  {
    name:        'restart_n8n_container',
    description: 'Restart the n8n Docker container, wait until healthy, and return webhook registration status.',
    category:    'n8n',
    schemaDef:   {
      container:      { type: 'string', optional: true, default: 'sulla_n8n', description: 'Docker container name or ID for n8n.' },
      timeoutMs:      { type: 'number', optional: true, default: 120000, description: 'Max time to wait for readiness after restart.' },
      pollIntervalMs: { type: 'number', optional: true, default: 2000, description: 'Polling interval for readiness checks.' },
      includeLogs:    { type: 'boolean', optional: true, default: true, description: 'Include recent webhook-related startup log lines in the response.' },
    },
    operationTypes: ['execute', 'update'],
    loader:         () => import('./restart_n8n_container'),
  },
  {
    name:        'validate_workflow',
    description: 'Validate an existing n8n workflow by ID and return graph health issues: floating nodes, missing credentials, broken connections, and nodes without type.',
    category:    'n8n',
    schemaDef:   {
      workflowId: { type: 'string', description: 'Workflow ID to validate.' },
    },
    operationTypes: ['read', 'execute'],
    loader:         () => import('./validate_workflow'),
  },
  {
    name:        'validate_workflow_payload',
    description: 'Validate an n8n workflow payload (nodes/connections/settings) before create/update.',
    category:    'n8n',
    schemaDef:   {
      name:            { type: 'string', description: 'Workflow name' },
      nodes:           { type: 'array', items: { type: 'object' }, description: 'Workflow nodes as n8n node objects.' },
      connections:     { type: 'object', description: 'Workflow connections object keyed by source node name.' },
      settings:        { type: 'object', optional: true, default: {}, description: 'Workflow settings object.' },
      shared:          { type: 'array', items: { type: 'object' }, optional: true, description: 'Shared users array.' },
      staticData:      { type: 'object', optional: true, description: 'Workflow staticData object.' },
      checkConnection: { type: 'boolean', optional: true, default: true, description: 'When true, also checks n8n API health connectivity.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./validate_workflow_payload'),
  },
];
