/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// One delegation path: hidden and tab children are both agent_jobs with a
// contract, show in the rail, return through return_result, and answer to the
// same message / progress / stop tools.

const query = jest.fn<any>(async() => []);
const send = jest.fn<any>(async() => true);
const graphStates = new Map<string, any>();
const execute = jest.fn<any>();
const appendCheckin = jest.fn<any>();
const targetsForJob = jest.fn<any>();
const queueMessage = jest.fn<any>();
const markMessagesDelivered = jest.fn<any>(async() => undefined);
const delegation = {
  safeStartDelegation:          jest.fn<any>(async() => 'delegation-1'),
  safeFinishDelegation:         jest.fn<any>(async() => undefined),
  safeFinishDelegationByRef:    jest.fn<any>(async() => undefined),
  safeMarkDelegationsDelivered: jest.fn<any>(async() => undefined),
  safeRejectDelegation:         jest.fn<any>(async() => undefined),
};
let threadCounter = 0;

jest.unstable_mockModule('../../../database/PostgresClient', () => ({
  postgresClient: {
    query,
    queryOne:    jest.fn<any>(async() => null),
    transaction: jest.fn<any>(async(callback: any) => callback({ query: async() => ({ rows: [] }) })),
  },
}));
jest.unstable_mockModule('../../../database/models/AgentDelegationModel', () => ({
  ...delegation,
  delegationSituation: () => '',
  delegationTaskId:    () => null,
}));
jest.unstable_mockModule('../../../database/models/AgentJobMessagingModel', () => ({
  AgentJobMessagingModel: {
    appendCheckin,
    targetsForJob,
    queueMessage,
    markMessagesDelivered,
    telemetryForJob: async() => ({}),
  },
}));
jest.unstable_mockModule('../../../database/models/ConversationHistoryModel', () => ({
  ConversationHistoryModel: { getById: async() => null },
}));
jest.unstable_mockModule('../../../services/GraphRegistry', () => ({
  nextThreadId: () => `thread_tab_${ ++threadCounter }`,
  GraphRegistry: {
    get:                   (threadId: string) => graphStates.has(threadId) ? { state: graphStates.get(threadId) } : undefined,
    delete:                jest.fn(),
    getOrCreateAgentGraph: async(_agentId: string, threadId: string) => {
      const state = graphStates.get(threadId) ?? { messages: [], metadata: { threadId, options: {} } };
      graphStates.set(threadId, state);
      return { graph: { execute }, state };
    },
  },
}));
jest.unstable_mockModule('../../../services/WebSocketClientService', () => ({
  getWebSocketClientService: () => ({ send }),
}));
jest.unstable_mockModule('../../../services/AgentDefinitionService', () => ({
  agentDefinitionService: { findBySlug: async(slug: string) => ({ slug, name: slug, enabled: true, status: 'production', can_call: [] }) },
}));
jest.unstable_mockModule('../../../services/ChatAgentRouting', () => ({
  SULLA_DESKTOP_CHANNEL_ID: 'sulla-desktop',
  resolveRoutableAgent:     async(id: string) => (id === 'missing' ? null : { agentId: id, graphAgentId: id, name: id === 'account-manager' ? 'Account Manager' : 'Project Manager' }),
  applyThreadAgentRoute:    (state: any, agent: any) => { state.metadata.routedAgentId = agent.graphAgentId },
}));
jest.unstable_mockModule('../../../services/RunActivity', () => ({
  RunActivity: {
    inherit:        (_meta: any, ...own: string[]) => own,
    lastActivityAt: () => undefined,
    touch:          () => undefined,
  },
  watchForDeadRun: () => () => undefined,
}));
jest.unstable_mockModule('../../../services/BackendGraphWebSocketService', () => ({
  getBackendGraphWebSocketService: () => ({ hasActiveRun: () => false }),
}));
jest.unstable_mockModule('../../../nodes/ThreadStateStore', () => ({
  loadThreadState: async() => null,
  saveThreadState: async() => undefined,
}));
jest.unstable_mockModule('../../../utils/sullaPaths', () => ({ findAgentDir: jest.fn(), resolveSullaLogsDir: () => '/logs' }));
jest.unstable_mockModule('electron', () => ({ ipcMain: { handle: jest.fn() } }));

// The renderer acknowledges a new tab as soon as it is asked to open one.
let acknowledge: (contractId: string, threadId: string) => boolean = () => false;
const rendererSend = jest.fn((_event: string, payload: any) => {
  if (payload?.command === 'open-agent-chat-tab') acknowledge(String(payload.contractId), String(payload.threadId));
});
jest.unstable_mockModule('@pkg/window', () => ({
  getWindow: () => ({ webContents: { send: rendererSend, isLoading: () => false, once: jest.fn() } }),
}));

const { acknowledgeAgentTabReady } = await import('../../../services/AgentTabOpener');
acknowledge = acknowledgeAgentTabReady;
const { SpawnAgentWorker } = await import('../spawn_agent');
const { ReturnResultWorker } = await import('../return_result');
const { ReturnAgentTabContractWorker } = await import('../../chat/return_contract');
const { LaunchAgentTabWorker } = await import('../../chat/launch_agent_tab');
const { SendJobMessageWorker } = await import('../send_job_message');
const { StopAgentJobWorker } = await import('../stop_agent_job');
const { ReportProgressWorker } = await import('../report_progress');
const { MessageAgentTabWorker } = await import('../../chat/message_tab');
const { ListAgentTabContractsWorker } = await import('../../chat/list_tab_contracts');
const { CheckAgentJobsWorker } = await import('../check_agent_jobs');
const { agentToolManifests } = await import('../manifests');
const { chatToolManifests } = await import('../../chat/manifests');
const { getJob, countOpenTabJobs, findTaskByThread } = await import('../jobRegistry');
const { fetchThreadAgentCards } = await import('../../../../main/agentsIpc');

function parent(threadId: string, extra: Record<string, unknown> = {}) {
  const worker = new SpawnAgentWorker();
  worker.setState({ messages: [], metadata: { wsChannel: 'sulla-desktop', threadId, routedAgentId: 'account-manager', ...extra } } as any);
  return worker;
}

function asChild<T extends { setState: (state: any) => void }>(worker: T, threadId: string): T {
  worker.setState({ messages: [], metadata: { threadId } } as any);
  return worker;
}

async function launchTab(parentThreadId: string, task: Record<string, unknown> = {}) {
  const result = await (parent(parentThreadId) as any)._validatedCall({
    tasks: [{ agentId: 'project-manager', prompt: 'Plan the launch', visibility: 'tab', ...task }],
  });
  expect(result.successBoolean).toBe(true);
  return JSON.parse(result.responseString);
}

function sentOfType(type: string) {
  return send.mock.calls.filter(([, message]: any) => message?.type === type) as Array<[string, any]>;
}

beforeEach(() => {
  send.mockClear();
  execute.mockReset();
  appendCheckin.mockReset();
  targetsForJob.mockReset();
  queueMessage.mockReset();
  markMessagesDelivered.mockClear();
  rendererSend.mockClear();
  Object.values(delegation).forEach(fn => fn.mockClear());
});

describe('one launch: hidden and tab children are both jobs', () => {
  it('shows a hidden child and a tab child in the parent rail from agents:thread-jobs', async() => {
    execute.mockImplementation(async(state: any) => {
      state.metadata.finalSummary = 'hidden done';
      return state;
    });
    const result = await (parent('rail-parent') as any)._validatedCall({
      tasks: [
        { agentId: 'codex-sol-worker', prompt: 'Build it', label: 'Backend' },
        { agentId: 'project-manager', prompt: 'Plan it', visibility: 'tab' },
      ],
    });
    expect(result.successBoolean).toBe(true);
    const launched = JSON.parse(result.responseString);
    expect(launched.mode).toBe('async');
    expect(launched.tabs).toHaveLength(1);

    const cards = await fetchThreadAgentCards('rail-parent');
    expect(cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'codex-sol-worker', kind: 'job' }),
      expect.objectContaining({
        agentId:  'project-manager',
        kind:     'tab',
        status:   'running',
        agentTab: expect.objectContaining({ contractId: launched.tabs[0].jobId, threadId: launched.tabs[0].childThreadId }),
      }),
    ]));
    // The tab was opened in the renderer with its job id as the contract id.
    expect(rendererSend).toHaveBeenCalledWith('agent-command', expect.objectContaining({
      command: 'open-agent-chat-tab', contractId: launched.tabs[0].jobId,
    }));
  });

  it('launch_agent_tab is an alias for a tab spawn and keeps its response shape', async() => {
    const worker = new LaunchAgentTabWorker();
    worker.setState({ messages: [], metadata: { wsChannel: 'sulla-desktop', threadId: 'alias-parent' } } as any);
    const result = await (worker as any)._validatedCall({ agentId: 'project-manager', brief: 'Plan the launch' });

    expect(result.successBoolean).toBe(true);
    const body = JSON.parse(result.responseString);
    expect(body.contractId).toBe(body.jobId);
    const job = await getJob(body.jobId);
    expect(job).toMatchObject({ visibility: 'tab', status: 'running', parentThreadId: 'alias-parent' });
    expect(job?.tasks[0]).toMatchObject({ visibility: 'tab', depth: 1, contract: { name: 'result' } });
    // The brief carries the contract footer.
    const brief = sentOfType('user_message').find(([, message]) => message.data.threadId === body.childThreadId);
    expect(brief?.[1].data.content).toContain('agents/return_result');
  });

  it('does not cap open tabs per chat (launch control lives in prompts)', async() => {
    for (let i = 0; i < 6; i++) await launchTab('busy-parent');
    const result = await (parent('busy-parent') as any)._validatedCall({
      tasks: [{ agentId: 'project-manager', prompt: 'one more', visibility: 'tab' }],
    });
    expect(result.successBoolean).toBe(true);
  });

  it('records depth on a grandchild tab without blocking it', async() => {
    const first = await launchTab('depth-root');
    const job = await getJob(first.jobId);
    job!.tasks[0].depth = 4;
    const result = await (parent(first.childThreadId) as any)._validatedCall({
      tasks: [{ agentId: 'project-manager', prompt: 'deeper', visibility: 'tab' }],
    });
    expect(result.successBoolean).toBe(true);
    const child = await getJob(JSON.parse(result.responseString).jobId);
    expect(child?.tasks[0].depth).toBe(5);
  });
});

describe('one return: return_result validates the contract', () => {
  const schema = {
    type:       'object',
    required:   ['lanes'],
    properties: { lanes: { type: 'array', items: { type: 'string' } } },
  };

  it('refuses a result that does not match the schema and keeps the tab open', async() => {
    const tab = await launchTab('schema-parent', { contract: { name: 'project-plan', schema } });
    const result = await (asChild(new ReturnResultWorker(), tab.childThreadId) as any)._validatedCall({ result: { lanes: 'not-an-array' } });

    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('does not match');
    expect((await getJob(tab.jobId))?.status).toBe('running');
    expect(sentOfType('user_message').some(([, m]) => m.data.threadId === 'schema-parent')).toBe(false);
  });

  it('accepts a matching result, closes the tab job and wakes the parent once', async() => {
    const tab = await launchTab('schema-parent-ok', { contract: { name: 'project-plan', schema } });
    send.mockClear();
    const result = await (asChild(new ReturnAgentTabContractWorker(), tab.childThreadId) as any)._validatedCall({
      contractId: tab.contractId,
      result:     { lanes: ['todo', 'doing', 'done'] },
      summary:    'Board is set up.',
    });

    expect(result.successBoolean).toBe(true);
    const job = await getJob(tab.jobId);
    expect(job).toMatchObject({ status: 'completed' });
    expect(job?.tasks[0]).toMatchObject({ status: 'completed', result: { lanes: ['todo', 'doing', 'done'] } });
    expect(job?.completionDeliveredAt).toBeTruthy();
    const wakes = sentOfType('user_message').filter(([, m]) => m.data.threadId === 'schema-parent-ok');
    expect(wakes).toHaveLength(1);
    expect(wakes[0][1].data.metadata.source).toBe('sub_agent_completion');
    expect(wakes[0][1].data.content).toContain('Board is set up.');
    expect(delegation.safeFinishDelegationByRef).toHaveBeenCalledWith(tab.jobId, expect.objectContaining({ outcome: 'completed', resultDelivered: true }));

    const again = await (asChild(new ReturnResultWorker(), tab.childThreadId) as any)._validatedCall({ result: { lanes: [] } });
    expect(again.successBoolean).toBe(false);
  });

  it('accepts schema fields sent at the top level instead of inside result', async() => {
    const tab = await launchTab('schema-parent-flat', { contract: { name: 'project-plan', schema } });
    const result = await (asChild(new ReturnResultWorker(), tab.childThreadId) as any)._validatedCall({ jobId: tab.jobId, lanes: ['todo'] });

    expect(result.successBoolean).toBe(true);
    expect((await getJob(tab.jobId))?.tasks[0].result).toEqual({ lanes: ['todo'] });
  });

  it('refuses a return from a thread that does not own the contract', async() => {
    const tab = await launchTab('owner-parent');
    const other = await launchTab('owner-parent-2');
    const result = await (asChild(new ReturnResultWorker(), other.childThreadId) as any)._validatedCall({
      contractId: tab.contractId, summary: 'not mine',
    });
    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('Only the child thread');
  });
});

describe('hidden children: contract fallback rules', () => {
  it('auto-returns the final text when the contract has no schema', async() => {
    execute.mockImplementation(async(state: any) => {
      state.metadata.finalSummary = 'Here is the report.';
      return state;
    });
    const result = await (parent('hidden-plain') as any)._validatedCall({
      tasks: [{ agentId: 'codex-sol-worker', prompt: 'Write the report' }],
      async: false,
    });

    expect(result.successBoolean).toBe(true);
    expect(result.responseString).toBe('Here is the report.');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('uses the returned contract when the child calls return_result', async() => {
    execute.mockImplementation(async(state: any) => {
      expect(state.messages[0].content).toContain('agents/return_result');
      await (asChild(new ReturnResultWorker(), state.metadata.threadId) as any)._validatedCall({
        status: 'completed', summary: 'Shipped the fix.', output: 'PR #12',
      });
      state.metadata.finalSummary = 'free text that should not win';
      return state;
    });
    const result = await (parent('hidden-returned') as any)._validatedCall({
      tasks: [{ agentId: 'codex-sol-worker', prompt: 'Fix it' }],
      async: false,
    });

    expect(result.successBoolean).toBe(true);
    expect(result.responseString).toContain('Shipped the fix.');
    expect(result.responseString).toContain('PR #12');
    expect(result.responseString).not.toContain('free text');
  });

  it('re-prompts once when a schema contract is not returned, then fails as no_contract', async() => {
    execute.mockImplementation(async(state: any) => {
      state.metadata.finalSummary = 'I am done (but did not return).';
      return state;
    });
    const result = await (parent('hidden-schema') as any)._validatedCall({
      tasks: [{
        agentId:  'codex-sol-worker',
        prompt:   'Audit it',
        contract: { name: 'audit', schema: { type: 'object', required: ['findings'] } },
      }],
      async: false,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    const state = execute.mock.calls[1][0] as any;
    expect(state.messages.at(-1).content).toContain('Return contract reminder');
    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('failed: no_contract');
  });

  it('accepts a schema return made after the reminder', async() => {
    let calls = 0;
    execute.mockImplementation(async(state: any) => {
      calls += 1;
      if (calls === 2) {
        await (asChild(new ReturnResultWorker(), state.metadata.threadId) as any)._validatedCall({ result: { findings: ['x'] } });
      }
      return state;
    });
    const result = await (parent('hidden-schema-late') as any)._validatedCall({
      tasks: [{ agentId: 'codex-sol-worker', prompt: 'Audit it', contract: { name: 'audit', schema: { type: 'object', required: ['findings'] } } }],
      async: false,
    });

    expect(result.successBoolean).toBe(true);
    expect(result.responseString).toContain('findings');
  });
});

describe('tab children live across turns and share the control surface', () => {
  it('stays open after its turns end; only a return or a stop closes it', async() => {
    const tab = await launchTab('persist-parent');
    // The child's first turn ran and ended through the desktop chat path —
    // nothing in that path settles the job.
    expect((await getJob(tab.jobId))?.status).toBe('running');
    expect(await countOpenTabJobs('persist-parent')).toBe(1);
    expect((await findTaskByThread(tab.childThreadId))?.job.jobId).toBe(tab.jobId);
    // Restarts must not sweep tab jobs.
    const sweep = query.mock.calls.map(([sql]) => String(sql)).find(sql => sql.includes("error = 'app restarted mid-job'"));
    expect(sweep).toContain("visibility <> 'tab'");
  });

  it('records report_progress from a tab child that is not flagged isSubAgent', async() => {
    const tab = await launchTab('progress-parent');
    appendCheckin.mockResolvedValue({ target: { jobId: tab.jobId, taskIndex: 0 }, checkin: { step: 'lanes', summary: 'lanes created' } });
    const result = await (asChild(new ReportProgressWorker(), tab.childThreadId) as any)._validatedCall({
      step: 'lanes', summary: 'lanes created', percent: 40,
    });

    expect(result.successBoolean).toBe(true);
    expect(appendCheckin).toHaveBeenCalledWith(tab.childThreadId, expect.objectContaining({ step: 'lanes', percent: 40 }));
  });

  it('delivers send_job_message to a tab child through its chat', async() => {
    const tab = await launchTab('message-parent');
    targetsForJob.mockResolvedValue([{ jobId: tab.jobId, taskIndex: 0, jobStatus: 'running', taskStatus: 'running', threadId: tab.childThreadId }]);
    queueMessage.mockResolvedValue({ id: 'msg-1' });
    const result = await (new SendJobMessageWorker() as any)._validatedCall({ jobId: tab.jobId, message: 'Use the default lanes.' });

    expect(result.successBoolean).toBe(true);
    expect(JSON.parse(result.responseString).deliveredLive).toBe(1);
    expect(send).toHaveBeenCalledWith('sulla-desktop', expect.objectContaining({
      type: 'inject_message',
      data: expect.objectContaining({ threadId: tab.childThreadId, content: expect.stringContaining('Use the default lanes.') }),
    }));
    expect(markMessagesDelivered).toHaveBeenCalledWith(['msg-1'], tab.childThreadId);
  });

  it('stop_agent_job stops a tab child\'s live turn and closes its job', async() => {
    const tab = await launchTab('stop-parent');
    const result = await (new StopAgentJobWorker() as any)._validatedCall({ jobId: tab.jobId });

    expect(result.successBoolean).toBe(true);
    expect((await getJob(tab.jobId))?.status).toBe('stopped');
    expect(send).toHaveBeenCalledWith('sulla-desktop', { type: 'stop_run', data: { threadId: tab.childThreadId } });
    expect(delegation.safeFinishDelegationByRef).toHaveBeenCalledWith(tab.jobId, expect.objectContaining({ outcome: 'failed' }));
    const late = await (asChild(new ReturnResultWorker(), tab.childThreadId) as any)._validatedCall({ summary: 'too late' });
    expect(late.successBoolean).toBe(false);
  });
});

describe('old tab tool names stay as aliases', () => {
  it('registers return_result and keeps the chat aliases', () => {
    expect(agentToolManifests.map(m => m.name)).toEqual(expect.arrayContaining(['spawn_agent', 'return_result']));
    expect(chatToolManifests.map(m => m.name)).toEqual(expect.arrayContaining(['launch_agent_tab', 'return_contract', 'message_tab', 'list_tab_contracts']));
  });

  it('message_tab routes to send_job_message, only for the launching chat', async() => {
    const tab = await launchTab('alias-msg-parent');
    targetsForJob.mockResolvedValue([{ jobId: tab.jobId, taskIndex: 0, jobStatus: 'running', taskStatus: 'running', threadId: tab.childThreadId }]);
    queueMessage.mockResolvedValue({ id: 'msg-2' });
    const own = asChild(new MessageAgentTabWorker(), 'alias-msg-parent');
    expect((await (own as any)._validatedCall({ contractId: tab.contractId, message: 'go' })).successBoolean).toBe(true);
    const stranger = asChild(new MessageAgentTabWorker(), 'someone-else');
    expect((await (stranger as any)._validatedCall({ childThreadId: tab.childThreadId, message: 'go' })).successBoolean).toBe(false);
  });

  it('list_tab_contracts and check_agent_jobs read the same tab jobs', async() => {
    const tab = await launchTab('alias-list-parent');
    const listed = JSON.parse((await (asChild(new ListAgentTabContractsWorker(), 'alias-list-parent') as any)._validatedCall({})).responseString);
    expect(listed).toEqual([expect.objectContaining({ contractId: tab.jobId, status: 'open', childThreadId: tab.childThreadId })]);
    const checked = await (new CheckAgentJobsWorker() as any)._validatedCall({ jobId: tab.jobId });
    expect(JSON.parse(checked.responseString).tasks[0]).toMatchObject({ visibility: 'tab', contract: 'result', returned: false });
  });
});
