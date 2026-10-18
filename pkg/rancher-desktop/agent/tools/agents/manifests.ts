import type { ToolManifest } from '../registry';

export const agentToolManifests: ToolManifest[] = [
  {
    name:        'spawn_agent',
    description: 'The one way to delegate. Launch one or more child agents, each with a return contract. visibility "hidden" (default) runs the child in the background; visibility "tab" opens it as a live chat tab the human can join (use for leads that run their own team or keep a visible Playbook). Every child shows in your sub-agent rail and your <subagent_directory> block, finishes with agents/return_result, and its result wakes you. Supports parallel execution and async (fire-and-forget) mode for hidden children.',
    category:    'meta',
    schemaDef:   {
      tasks: {
        type:        'array',
        description: 'Array of task objects. Each task has: prompt (required — the instruction), agentId (optional — database-backed custom agent slug, defaults to the parent/primary agent; agentName is accepted as an alias; pick the right specialist with agents_directory), label (optional — human-readable name for the task), projectTaskId (required when the sub-agent works a Projects task — the job then owns that task for its run and launch is refused if another agent already owns it). A non-empty agentId/agentName that does not match an enabled agent definition is rejected — it is NOT silently run as the default agent.',
        items:       {
          type:       'object',
          properties: {
            agentId:   { type: 'string', description: 'Database-backed agent slug (e.g. "codex-test"). Omit to use the default agent. Must match an enabled agent definition.', optional: true },
            agentName: { type: 'string', description: 'Alias for agentId. Same resolution rules.', optional: true },
            prompt:    { type: 'string', description: 'The task/instruction to give the sub-agent.' },
            projectTaskId: { type: 'string', optional: true, description: 'REQUIRED whenever the sub-agent works a Projects task: the task id (e.g. "AwBS"). The job owns that task for its whole run (assignee = this agent; other sessions stay off it) and hands it back when the job ends. Launch is refused if another agent already owns the task.' },
            workspacePath: {
              type:        'string',
              optional:    true,
              description: 'Container agents only: explicit existing worktree under ~/Sites/worktrees used to seed the job retained isolated clone. Shared Git metadata is never mounted.',
            },
            label:     { type: 'string', description: 'Optional human-readable label for this task (the tab title for visibility "tab").', optional: true },
            visibility: { type: 'enum', enum: ['hidden', 'tab'], optional: true, description: '"hidden" (default): background worker. "tab": a live chat tab that stays open across turns until the child returns its contract or you stop it. Max 5 open tabs per chat.' },
            contract:  {
              type:        'object',
              optional:    true,
              description: 'What the child must return. Omit for the default {status: completed|blocked|failed, summary, output}. Use {name:"ui-test-issues"} for the built-in UI test schema. With a schema, a hidden child that ends without returning gets one reminder, then fails as no_contract.',
              properties: {
                name:        { type: 'string', description: 'Contract name or built-in preset name.' },
                description: { type: 'string', optional: true, description: 'What the returned result represents.' },
                schema:      { type: 'object', optional: true, description: 'JSON Schema the result must match.' },
              },
            },
            focus:     { type: 'boolean', optional: true, description: 'Tab only: focus the new tab. Defaults to false so the parent composer keeps focus.' },
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
        description: 'When true (default), launches agents in the background and returns immediately with a jobId. Results wake the parent graph on completion; check_agent_jobs is the fallback/history read. Set to false to block until all hidden agents complete (tab children never block).',
      },
    },
    operationTypes: ['execute'],
    loader:         () => import('./spawn_agent'),
  },
  {
    name:        'return_result',
    description: 'Finish your delegated task by returning its contract to the agent that launched you (hidden worker or agent tab). The result is checked against the contract in your brief; a mismatch is refused so you can fix it. Default contract: {status: completed|blocked|failed, summary, output}. A tab closes only when you call this.',
    category:    'agents',
    schemaDef:   {
      status:  { type: 'enum', enum: ['completed', 'blocked', 'failed'], optional: true, description: 'Default contract: how it went. Defaults to completed.' },
      summary: { type: 'string', optional: true, description: 'Default contract: one-paragraph summary (required there). With a custom schema: optional human-readable note.' },
      output:  { type: 'any', optional: true, description: 'Default contract: the deliverable in any JSON shape (text, links, findings, or structured data). May also be sent inside result.' },
      result:  { type: 'object', optional: true, description: 'Custom-schema contracts: the structured value matching the schema exactly.' },
      jobId:   { type: 'string', optional: true, description: 'Job/contract id from your brief. Optional; your thread identifies the job.' },
    },
    operationTypes: ['update', 'execute'],
    loader:         () => import('./return_result'),
  },
  {
    name:        'check_agent_jobs',
    description: 'Inspect delegated jobs (hidden and tab), including visibility, contract, per-task elapsed time, latest and recent check-ins, blockers, touched files, and undelivered orchestrator-message counts.',
    category:    'agents',
    schemaDef:   {
      jobId: { type: 'string', optional: true, description: 'The job ID returned by an async spawn_agent call. Omit to list all jobs.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./check_agent_jobs'),
  },
  {
    name:        'send_job_message',
    description: 'Send new direction to one or all running tasks in a delegated job, hidden or tab. Hidden workers get it live when possible, otherwise at their next model-call boundary; a tab child gets it in its chat (steers a live turn or starts one).',
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
    description: 'Record a milestone check-in for your current delegated task (hidden worker or agent tab). Call it at meaningful milestones and at least every ~5 minutes; your parent sees it in its subagent directory.',
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
    description: 'Kill switch for a running delegated job, hidden or tab. Hidden: fires the job\'s abort signal, which cascades to every sub-agent it spawned, unwinding them cooperatively (an in-flight LLM/tool call finishes first). Tab: stops the tab\'s live turn and closes its contract. Use when a job was misfired, duplicated, stalled, or is no longer needed; check_agent_jobs afterwards confirms it settled as \'stopped\'.',
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
    description:    'List the live named agents you can message (heartbeat, mobile-relay, other frontends) with their channel, status, and uptime — the roster from turn context, queryable on demand. Message any with a <channel:CHANNEL>text</channel:CHANNEL> tag (fire-and-forget; the reply arrives on a later turn). Use spawn_agent for bounded delegated work.',
    category:       'agents',
    schemaDef:      {},
    operationTypes: ['read'],
    loader:         () => import('./list_agents'),
  },
  {
    name:        'agents_directory',
    description: 'Directory of every callable custom agent (from agent_definitions) as compact cards: when to call it, when not to, what to send, what it returns, cost tier, and which agents it can call. Use it to pick the right specialist before spawn_agent. Search with query, fetch one card with slug, or omit both to list all enabled agents.',
    category:    'agents',
    schemaDef:   {
      query:           { type: 'string', optional: true, description: 'Free-text description of the work (e.g. "build a dashboard from sales data"); returns matching agents, best first.' },
      slug:            { type: 'string', optional: true, description: 'Return the card for this one agent slug (includes disabled/archived agents).' },
      includeInactive: { type: 'boolean', optional: true, description: 'Also list disabled and archived agents (default false).' },
      limit:           { type: 'number', optional: true, description: 'Maximum number of cards to return.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./agent_directory'),
  },
];
