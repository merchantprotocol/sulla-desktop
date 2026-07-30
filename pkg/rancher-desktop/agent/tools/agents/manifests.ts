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
  {
    name:        'stop_agent_job',
    description: 'Kill switch for a running async sub-agent job (from spawn_agent(async: true)). Fires the job\'s abort signal, which cascades to every sub-agent it spawned, unwinding them cooperatively (an in-flight LLM/tool call finishes first, then the loop stops). Use when a job was misfired, duplicated, or is no longer needed. Poll check_agent_jobs afterwards to confirm it settled as \'stopped\'.',
    category:    'agents',
    schemaDef:   {
      jobId: { type: 'string', description: 'The job ID to cancel (returned by the async spawn_agent call).' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./stop_agent_job'),
  },
  {
    name:        'start_agent_conversation',
    description: 'Open a persistent, multi-turn conversation with a sub-agent (vs. spawn_agent\'s fire-and-forget). Runs the first turn and returns the sub-agent\'s reply plus a conversationId. The sub-agent stays alive between messages, keeping full context, so you can delegate then clarify, correct, or ask follow-ups. Continue with send_agent_message; end with close_agent_conversation.',
    category:    'agents',
    schemaDef:   {
      prompt:  { type: 'string', description: 'The opening message/instruction to the sub-agent.' },
      agentId: { type: 'string', optional: true, description: 'Agent config ID from ~/sulla/agents/. Omit to use the primary agent persona.' },
      label:   { type: 'string', optional: true, description: 'Human-readable label for this conversation.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./start_agent_conversation'),
  },
  {
    name:        'send_agent_message',
    description: 'Send a follow-up message to an open sub-agent conversation and get its reply. The sub-agent retains its full prior context (same thread), so you can clarify, correct course, or ask it to continue. Blocks for the sub-agent\'s turn.',
    category:    'agents',
    schemaDef:   {
      conversationId: { type: 'string', description: 'The conversationId from start_agent_conversation.' },
      message:        { type: 'string', description: 'What to say to the sub-agent.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./send_agent_message'),
  },
  {
    name:        'read_agent_conversation',
    description: 'Read the transcript of an open sub-agent conversation, or list all open conversations when called without a conversationId.',
    category:    'agents',
    schemaDef:   {
      conversationId: { type: 'string', optional: true, description: 'Conversation to read. Omit to list all open conversations.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./read_agent_conversation'),
  },
  {
    name:        'close_agent_conversation',
    description: 'Close a sub-agent conversation and free its resources (drops the sub-agent\'s graph + state). Do this when you\'re done talking to a sub-agent.',
    category:    'agents',
    schemaDef:   {
      conversationId: { type: 'string', description: 'The conversation to close.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./close_agent_conversation'),
  },
  {
    name:           'list_agents',
    description:    'List the live named agents you can message (heartbeat, workbench, mobile-relay, other frontends) with their channel, status, and uptime — the roster from turn context, queryable on demand. Message any with a <channel:CHANNEL>text</channel:CHANNEL> tag (fire-and-forget; the reply arrives on a later turn). For a synchronous back-and-forth with a freshly delegated sub-agent, use start_agent_conversation instead.',
    category:       'agents',
    schemaDef:      {},
    operationTypes: ['read'],
    loader:         () => import('./list_agents'),
  },
];
