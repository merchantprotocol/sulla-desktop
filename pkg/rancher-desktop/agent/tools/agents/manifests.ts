import type { ToolManifest } from '../registry';

export const agentToolManifests: ToolManifest[] = [
  {
    name:        'spawn_agent',
    description: 'Spawn one or more sub-agents to work on tasks independently. Each sub-agent runs with its own conversation thread and agent persona, then returns results. Supports parallel execution and async (fire-and-forget) mode.',
    category:    'meta',
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
      parallel: {
        type:        'boolean',
        optional:    true,
        description: 'When true, all tasks run in parallel (default). When false, tasks run sequentially one after another.',
      },
      async: {
        type:        'boolean',
        optional:    true,
        description: 'When true (default), launches agents in the background and returns immediately with a jobId. Use check_agent_jobs to poll for results. Set to false to block until all agents complete.',
      },
    },
    operationTypes: ['execute'],
    loader:         () => import('./spawn_agent'),
  },
  {
    name:        'check_agent_jobs',
    description: 'Check the status and results of async sub-agent jobs launched with spawn_agent(async: true). Pass a jobId to check a specific job, or omit to list all pending/completed jobs.',
    category:    'agents',
    schemaDef:   {
      jobId: { type: 'string', optional: true, description: 'The job ID returned by an async spawn_agent call. Omit to list all jobs.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./check_agent_jobs'),
  },
];
