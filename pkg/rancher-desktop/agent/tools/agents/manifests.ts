import type { ToolManifest } from '../registry';

export const agentToolManifests: ToolManifest[] = [
  {
    name:        'spawn_agent',
    description: 'Spawn one or more sub-agents to work on tasks independently. Each sub-agent runs with its own conversation thread and agent persona, then returns results. Supports parallel execution and async (fire-and-forget) mode.',
    category:    'meta',
    schemaDef:   {
      tasks: {
        type:        'array',
        description: 'Array of task objects. Each task has: prompt (required — the instruction), agentId (optional — database-backed custom agent slug, defaults to the parent/primary agent; agentName is accepted as an alias), label (optional — human-readable name for the task), projectTaskId (required when the sub-agent works a Projects task — the job then owns that task for its run and launch is refused if another agent already owns it). A non-empty agentId/agentName that does not match an enabled agent definition is rejected — it is NOT silently run as the default agent.',
        items:       {
          type:       'object',
          properties: {
            agentId:   { type: 'string', description: 'Database-backed agent slug (e.g. "codex-test"). Omit to use the default agent. Must match an enabled agent definition.', optional: true },
            agentName: { type: 'string', description: 'Alias for agentId. Same resolution rules.', optional: true },
            prompt:    { type: 'string', description: 'The task/instruction to give the sub-agent.' },
            projectTaskId: { type: 'string', optional: true, description: 'REQUIRED whenever the sub-agent works a Projects task: the task id (e.g. "AwBS"). The job owns that task for its whole run (assignee = this agent; the dispatcher and other sessions stay off it) and hands it back when the job ends. Launch is refused if another agent already owns the task.' },
            label:     { type: 'string', description: 'Optional human-readable label for this task.', optional: true },
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
        description: 'When true (default), launches agents in the background and returns immediately with a jobId. Results wake the parent graph on completion; check_agent_jobs is the fallback/history read. Set to false to block until all agents complete.',
      },
    },
    operationTypes: ['execute'],
    loader:         () => import('./spawn_agent'),
  },
  {
    name:        'check_agent_jobs',
    description: 'Inspect async spawn_agent jobs, including per-task elapsed time, latest and recent worker check-ins, blockers, touched files, and undelivered orchestrator-message counts.',
    category:    'agents',
    schemaDef:   {
      jobId: { type: 'string', optional: true, description: 'The job ID returned by an async spawn_agent call. Omit to list all jobs.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./check_agent_jobs'),
  },
  {
    name:        'send_job_message',
    description: 'Send new direction to one or all queued/running tasks in a spawn_agent job. The message is persisted and delivered live when possible, otherwise at the worker\'s next model-call boundary.',
    category:    'agents',
    schemaDef:   {
      jobId:     { type: 'string', description: 'The job ID returned by spawn_agent.' },
      taskIndex: { type: 'number', optional: true, description: 'Zero-based task index. Omit to target every queued/running task in the job.' },
      message:   { type: 'string', description: 'Direction for the worker, delivered with a clear "Message from orchestrator" label.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./send_job_message'),
  },
  {
    name:        'report_progress',
    description: 'Record a milestone check-in for the current spawn_agent worker task. Workers should call this at meaningful milestones and at least every ~5 minutes.',
    category:    'agents',
    schemaDef:   {
      step:         { type: 'string', description: 'Short milestone or phase name.' },
      summary:      { type: 'string', description: 'What changed or was verified since the previous check-in.' },
      filesTouched: { type: 'array', items: { type: 'string' }, optional: true, description: 'Files created or changed so far.' },
      blockers:     { type: 'array', items: { type: 'string' }, optional: true, description: 'Concrete blockers requiring orchestrator or human action.' },
      percent:      { type: 'number', optional: true, description: 'Optional completion estimate from 0 to 100.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./report_progress'),
  },
  {
    name:        'stop_agent_job',
    description: 'Kill switch for a running async sub-agent job (from spawn_agent(async: true)). Fires the job\'s abort signal, which cascades to every sub-agent it spawned, unwinding them cooperatively (an in-flight LLM/tool call finishes first, then the loop stops). Use when a job was misfired, duplicated, or is no longer needed. Results wake the parent graph; check_agent_jobs afterwards is the fallback/history read to confirm it settled as \'stopped\'.',
    category:    'agents',
    schemaDef:   {
      jobId: { type: 'string', description: 'The job ID to cancel (returned by the async spawn_agent call).' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./stop_agent_job'),
  },
  {
    name:        'start_agent_conversation',
    description: 'DEPRECATED compatibility wrapper over spawn_agent. Launches one async job and returns jobId plus a conversationId alias. Results wake the parent graph; use check_agent_jobs only as fallback/history. Multi-turn follow-ups are not supported.',
    category:    'agents',
    schemaDef:   {
      prompt:  { type: 'string', description: 'The opening message/instruction to the sub-agent.' },
      agentId: { type: 'string', optional: true, description: 'Database-backed agent slug. Omit to use the primary agent persona.' },
      label:   { type: 'string', optional: true, description: 'Human-readable label for this conversation.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./start_agent_conversation'),
  },
  {
    name:        'send_agent_message',
    description: 'DEPRECATED conversation compatibility surface. For a running spawn_agent job, use send_job_message with its jobId instead.',
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
    description:    'List the live named agents you can message (heartbeat, workbench, mobile-relay, other frontends) with their channel, status, and uptime — the roster from turn context, queryable on demand. Message any with a <channel:CHANNEL>text</channel:CHANNEL> tag (fire-and-forget; the reply arrives on a later turn). Use spawn_agent for bounded delegated work.',
    category:       'agents',
    schemaDef:      {},
    operationTypes: ['read'],
    loader:         () => import('./list_agents'),
  },
];
