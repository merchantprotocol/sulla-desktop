import type { ToolManifest } from '../registry';

export const agentToolManifests: ToolManifest[] = [
  {
    name:        'spawn_agent',
    description: 'Spawn one or more sub-agents to work on tasks independently. Each sub-agent runs with its own conversation thread and agent persona, then returns results when complete. Pass a single task for one agent, or multiple tasks for parallel execution. Use list_agents first to discover available agent configurations.',
    category:    'agents',
    schemaDef:   {
      tasks: {
        type:        'array',
        description: 'Array of task objects. Each task has: prompt (required — the instruction), agentId (optional — agent config from ~/sulla/agents/, defaults to primary agent), label (optional — human-readable name for the task).',
        items:       {
          type:       'object',
          properties: {
            agentId: { type: 'string', description: 'Agent config ID from ~/sulla/agents/. Omit to use the default agent.', optional: true },
            prompt:  { type: 'string', description: 'The task/instruction to give the sub-agent.' },
            label:   { type: 'string', description: 'Optional human-readable label for this task.', optional: true },
          },
        },
      },
    },
    operationTypes: ['execute'],
    loader:         () => import('./spawn_agent'),
  },
  {
    name:        'list_agents',
    description: 'List all available agent configurations from ~/sulla/agents/ with their names, descriptions, and capabilities. Use this to discover which agentId values are available before spawning sub-agents.',
    category:    'agents',
    schemaDef:   {},
    operationTypes: ['read'],
    loader:         () => import('./list_agents'),
  },
];
