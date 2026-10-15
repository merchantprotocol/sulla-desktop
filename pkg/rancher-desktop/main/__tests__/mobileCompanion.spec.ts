/** @jest-environment node */
import { jest } from '@jest/globals';
import mockModules from '@pkg/utils/testUtils/mockModules';
const getProject = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 'p1', archived: false });
const listTasks = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]);
const getTask = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 't1', project_id: 'p1', archived: false });
const listComments = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([{ id: 'c1', body: 'hi' }]);
const addComment = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 'c2', body: 'from phone', author: 'human' });
const projectServiceGetProject = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 'p1', archived: false });
const projectServiceGetTask = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 't1', project_id: 'p1', archived: false });
const projectServiceListEpics = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([{ id: 'e1', project_id: 'p1' }]);
const projectServiceCreateTask = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 't2', project_id: 'p1', epic_id: 'e1', title: 'Cloud task', status: 'todo' });
const projectServiceUpdateTask = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 't1', project_id: 'p1', epic_id: 'e1', title: 'Updated', status: 'in_progress' });
const sendJobMessage = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ successBoolean: true, responseString: '{}' });
const stopAgentJob = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ successBoolean: true, responseString: 'stopped' });
const agentJob = { jobId: 'agent-job-1', status: 'running', tasks: [{ threadId: 'thread-1', status: 'running' }] };
const getJob = jest.fn<(...args: any[]) => Promise<any>>().mockImplementation(async id => id === agentJob.jobId ? agentJob : undefined);
const findTaskByThread = jest.fn<(...args: any[]) => Promise<any>>().mockImplementation(async id => id === 'thread-1' ? { job: agentJob, taskIndex: 0 } : undefined);
const getAllJobs = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]);
const telemetryForJob = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({});
const getAllAgents = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]);
const set = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined);
const resolveQuestion = jest.fn<(...args: any[]) => boolean>().mockReturnValue(true);
const resolve = jest.fn<(...args: any[]) => boolean>().mockReturnValue(true);
const decisionResolve = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ settled: true, conversationId: 'original' });
const listBookmarks = jest.fn<() => Promise<any>>().mockResolvedValue([
  { id: 'b1', parent_id: null, kind: 'bookmark', title: 'Admin', url: 'http://localhost:6152/admin', favicon: `data:image/png;base64,${ 'A'.repeat(20_000) }`, position: 0 },
  { id: 'b2', parent_id: null, kind: 'bookmark', title: 'Docs', url: 'https://docs.example.com/', favicon: 'data:image/png;base64,AA', position: 1 },
]);
const listDockerLinks = jest.fn<() => Promise<any>>().mockResolvedValue({ available: true, links: [{ id: 'docker:web:8080', url: 'http://localhost:8080/' }] });
const openPreview = jest.fn<(url: string) => Promise<any>>().mockResolvedValue({ url: 'https://abc.trycloudflare.com/__sulla_preview/enter?t=x', expiresAt: 'soon' });
const closePreview = jest.fn<(origin: string) => Promise<void>>().mockResolvedValue(undefined);
const selectModel = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined);
const getModelsForProvider = jest.fn<(id: string) => Promise<any>>().mockImplementation(async id => (id === 'claude-code'
  ? [{ id: 'claude-code', name: 'Auto' }, { id: 'claude-opus-5-5', name: 'Opus 5.5' }]
  : [{ id: 'grok-4.6', name: 'Grok 4.6' }]));
const modelProviders = {
  getState:              () => ({ primaryProvider: 'claude-code', activeModelId: 'claude-opus-5-5' }),
  getAvailableProviders: jest.fn<() => Promise<any>>().mockResolvedValue([
    { id: 'claude-code', name: 'Claude Code', connected: true },
    { id: 'grok', name: 'Grok', connected: true },
    { id: 'openai', name: 'OpenAI', connected: false },
  ]),
  getModelsForProvider,
  selectModel,
};
const realLoopback = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url);
mockModules({
  '@pkg/agent/services/DecisionService': { decisionService: { list: jest.fn<() => Promise<any>>().mockResolvedValue([]), resolve: decisionResolve } },
  '@pkg/agent/database/models/WorkItemsModel': { WorkItemsModel: { getProject, listTasks, getTask, listComments, listProjects: jest.fn(), listRecentActivity: jest.fn<() => Promise<any>>().mockResolvedValue([]) } },
  '@pkg/agent/database/models/WorkLaneDefinitionModel': { WorkLaneDefinitionModel: { resolveEffective: jest.fn<() => Promise<any>>().mockResolvedValue([{ lane_key: 'custom' }]) } },
  '@pkg/agent/database/models/SullaSettingsModel': { SullaSettingsModel: { set, get: jest.fn<() => Promise<any>>().mockResolvedValue(false) } },
  '@pkg/agent/services/ModelProviderService': { getModelProviderService: () => modelProviders },
  '@pkg/agent/services/HeartbeatService': { getHeartbeatService: () => ({ getStatus: () => ({ isExecuting: false }), getHistory: () => [] }) },
  '@pkg/agent/services/ActiveAgentsRegistry': { getActiveAgentsRegistry: () => ({ getAllAgents }) },
  '@pkg/agent/database/models/AgentJobMessagingModel': { AgentJobMessagingModel: { telemetryForJob } },
  '@pkg/agent/projects/application/ProjectsApplicationService': { getProjectsApplicationService: () => ({
    addComment,
    ready:      jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getProject: projectServiceGetProject,
    getTask:    projectServiceGetTask,
    listEpics:  projectServiceListEpics,
    createTask: projectServiceCreateTask,
    updateTask: projectServiceUpdateTask,
  }) },
  '@pkg/agent/tools/agents/send_job_message': { sendJobMessage },
  '@pkg/agent/tools/agents/jobRegistry': { getJob, getAllJobs, findTaskByThread },
  '@pkg/agent/tools/agents/stop_agent_job': { stopAgentJob },
  '@pkg/agent/services/ApprovalService': { ApprovalService: { getInstance: () => ({ resolveQuestion, resolve }) } },
  '@pkg/agent/database/models/BrowserBookmarkModel': { BrowserBookmarkModel: { list: listBookmarks } },
  '@pkg/main/dockerLinks': { listDockerLinks },
  '@pkg/main/previewShare': { isLoopbackUrl: realLoopback, previewShares: { open: openPreview, close: closePreview } },
});
const { mobileCompanionRequest: request, registerMobileCard } = await import('@pkg/main/mobileCompanion');
beforeEach(() => {
  jest.clearAllMocks();
  resolveQuestion.mockReturnValue(true);
  getTask.mockResolvedValue({ id: 't1', project_id: 'p1', archived: false });
  projectServiceGetProject.mockResolvedValue({ id: 'p1', archived: false });
  projectServiceGetTask.mockResolvedValue({ id: 't1', project_id: 'p1', archived: false });
  projectServiceListEpics.mockResolvedValue([{ id: 'e1', project_id: 'p1' }]);
  sendJobMessage.mockResolvedValue({ successBoolean: true, responseString: '{}' });
  stopAgentJob.mockResolvedValue({ successBoolean: true, responseString: 'stopped' });
  getAllJobs.mockResolvedValue([]);
  telemetryForJob.mockResolvedValue({});
  getAllAgents.mockResolvedValue([]);
});
test('rejects arbitrary remote commands', async() => {
  await expect(request('exec', { command: 'anything' })).rejects.toThrow('Unsupported');
  expect(set).not.toHaveBeenCalled();
});
test('loads tasks scoped to the requested project with custom lanes', async() => {
  await expect(request('projects.detail', { projectId: 'p1' })).resolves.toMatchObject({ lanes: [{ lane_key: 'custom' }] });
  expect(listTasks).toHaveBeenCalledWith({ projectId: 'p1', includeDone: true, limit: 5000 });
});
test('does not coerce invalid toggle values or arbitrary settings', async() => {
  await expect(request('heartbeat.update', { enabled: 'true', dangerous: true })).rejects.toThrow('Invalid');
  expect(set).not.toHaveBeenCalled();
});
test('updates only the requested Heartbeat setting', async() => {
  await request('heartbeat.update', { enabled: true });
  expect(set).toHaveBeenCalledWith('heartbeatEnabled', true, 'boolean');
  expect(set).toHaveBeenCalledTimes(1);
});
test('questions are bound to their originating conversation and settle once', async() => {
  registerMobileCard('c1', 'tool_question', { toolQuestion: { questionId: 'q1', questions: [{ question: 'Choose?', options: [{ label: 'A' }] }] } });
  await expect(request('chat.answer', { id: 'q1', conversationId: 'c2', answers: [{ selected: ['A'] }] })).rejects.toThrow('no longer');
  expect(resolveQuestion).not.toHaveBeenCalled();
  await expect(request('chat.answer', { id: 'q1', conversationId: 'c1', answers: [{ selected: ['A'] }] })).resolves.toEqual({ accepted: true });
  await expect(request('chat.answer', { id: 'q1', conversationId: 'c1', answers: [{ selected: ['A'] }] })).rejects.toThrow('no longer');
  expect(resolveQuestion).toHaveBeenCalledTimes(1);
});
test('expired question is rejected rather than shown as approved', async() => {
  resolveQuestion.mockReturnValue(false);
  registerMobileCard('c1', 'tool_question', { toolQuestion: { questionId: 'q2', questions: [{ question: 'Choose?', options: [] }] } });
  await expect(request('chat.answer', { id: 'q2', conversationId: 'c1', answers: [{ selected: ['A'] }] })).rejects.toThrow('expired');
});
test('single-select cards reject multiple answers', async() => {
  registerMobileCard('c1', 'tool_question', { toolQuestion: { questionId: 'q3', questions: [{ question: 'Choose?', options: [] }] } });
  await expect(request('chat.answer', { id: 'q3', conversationId: 'c1', answers: [{ selected: ['A','B'] }] })).rejects.toThrow('Choose one');
  expect(resolveQuestion).not.toHaveBeenCalled();
});

test('remote Decide forwards the exact originating conversation, never dispatches a new chat', async() => {
  const response = { id: 'decision', conversationId: 'original', action: 'approved' };
  await expect(request('decisions.resolve', response)).resolves.toMatchObject({ settled: true, conversationId: 'original' });
  expect(decisionResolve).toHaveBeenCalledWith(response);
  expect(set).not.toHaveBeenCalled();
});
test('remote callers cannot alter tool approval policies', async() => {
  await expect(request('decisions.set-policy', { name: 'git_push', required: false })).rejects.toThrow('Unsupported');
  expect(set).not.toHaveBeenCalled();
});

test('opens one ticket with its project, lanes and comment thread', async() => {
  await expect(request('projects.task', { taskId: 't1' })).resolves.toMatchObject({ task: { id: 't1' }, project: { id: 'p1' }, lanes: [{ lane_key: 'custom' }], comments: [{ id: 'c1' }] });
  expect(listComments).toHaveBeenCalledWith('t1');
});
test('archived or unknown tickets are not served', async() => {
  getTask.mockResolvedValueOnce({ id: 't1', project_id: 'p1', archived: true });
  await expect(request('projects.task', { taskId: 't1' })).rejects.toThrow('not found');
  await expect(request('projects.task', { taskId: 42 })).rejects.toThrow('Task required');
});
test('phone comments are always posted as the human, trimmed', async() => {
  await expect(request('projects.comment', { taskId: 't1', body: '  from phone  ', author: 'heartbeat' })).resolves.toMatchObject({ comment: { id: 'c2' } });
  expect(addComment).toHaveBeenCalledWith({ task_id: 't1', body: 'from phone', author: 'human' }, { actor: 'human', source: 'ipc' });
});
test('empty or oversized comments are rejected before touching the task', async() => {
  await expect(request('projects.comment', { taskId: 't1', body: '   ' })).rejects.toThrow('Write a comment');
  await expect(request('projects.comment', { taskId: 't1', body: 'x'.repeat(20001) })).rejects.toThrow('Write a comment');
  expect(getTask).not.toHaveBeenCalled();
  expect(addComment).not.toHaveBeenCalled();
});
test('cloud board creates tasks through the Projects service with a fixed actor', async() => {
  await expect(request('projects.create_task', {
    projectId: 'p1', title: '  Cloud task  ', status: 'todo', priority: 'high', assignee: 'sulla',
  })).resolves.toMatchObject({ task: { id: 't2' } });
  expect(projectServiceListEpics).toHaveBeenCalledWith({ projectId: 'p1', includeDone: true, limit: 1000 });
  expect(projectServiceCreateTask).toHaveBeenCalledWith({
    epic_id: 'e1', title: 'Cloud task', status: 'todo', priority: 'high', assignee: 'sulla', source: 'cloud-dashboard', actor: 'cloud-dashboard',
  }, { actor: 'cloud-dashboard', source: 'ipc' });
});
test('cloud board updates status or lane through the Projects service with a fixed actor', async() => {
  await expect(request('projects.update_task', { taskId: 't1', lane: 'in_progress', title: ' Updated ', assignee: null }))
    .resolves.toMatchObject({ task: { id: 't1' } });
  expect(projectServiceUpdateTask).toHaveBeenCalledWith('t1', {
    title: 'Updated', status: 'in_progress', assignee: null, source: 'cloud-dashboard', actor: 'cloud-dashboard',
  }, { actor: 'cloud-dashboard', source: 'ipc' });
});
test('cloud board rejects unknown projects and tasks', async() => {
  projectServiceGetProject.mockResolvedValueOnce(null);
  await expect(request('projects.create_task', { projectId: 'missing', title: 'Nope' })).rejects.toThrow('Project not found');
  projectServiceGetTask.mockResolvedValueOnce(null);
  await expect(request('projects.update_task', { taskId: 'missing', status: 'todo' })).rejects.toThrow('Task not found');
});
test('cloud agent controls resolve a job or thread and use the existing job internals', async() => {
  await expect(request('agents.message', { threadId: 'thread-1', message: ' Keep the scope tight. ' }))
    .resolves.toEqual({ accepted: true, jobId: 'agent-job-1', taskIndex: 0 });
  expect(sendJobMessage).toHaveBeenCalledWith({ jobId: 'agent-job-1', taskIndex: 0, message: 'Keep the scope tight.' });

  await expect(request('agents.pause', { jobId: 'agent-job-1' }))
    .resolves.toMatchObject({ paused: true, mode: 'cooperative-hold' });
  await expect(request('agents.resume', { jobId: 'agent-job-1' }))
    .resolves.toMatchObject({ resumed: true, mode: 'cooperative-hold' });
  await expect(request('agents.stop', { jobId: 'agent-job-1' }))
    .resolves.toMatchObject({ stopped: true, mode: 'cooperative-stop' });
  expect(stopAgentJob).toHaveBeenCalledWith('agent-job-1');
});
test('cloud fleet lists live agents and bounded recent job telemetry without prompts or results', async() => {
  const now = Date.now();
  getAllAgents.mockResolvedValue([
    { agentId: 'heartbeat', name: 'Heartbeat', channel: 'heartbeat', type: 'heartbeat', status: 'running', startedAt: now - 5_000, statusNote: `Auditing ${ 'x'.repeat(500) }` },
    { agentId: 'human', name: 'Jonathon', channel: 'human', type: 'human', status: 'idle', startedAt: now - 5_000 },
  ]);
  getAllJobs.mockResolvedValue([
    {
      jobId: 'agent-job-old', status: 'completed', createdAt: now - 48 * 60 * 60 * 1000,
      finishedAt: now - 47 * 60 * 60 * 1000, visibility: 'hidden', parentThreadId: 'parent-old', tasks: [],
      prompt: 'never expose me', results: [{ output: 'nor me' }],
    },
    {
      jobId: 'agent-job-live', status: 'running', createdAt: now - 10_000, finishedAt: null,
      visibility: 'tab', parentThreadId: 'parent-1', prompt: 'private brief', results: [{ output: 'private transcript' }],
      tasks: [{ agentId: 'codex-sol-worker', label: 'Fleet API', status: 'running', threadId: 'thread-live', prompt: 'private task prompt' }],
    },
  ]);
  telemetryForJob.mockResolvedValue({
    0: { latestCheckin: { step: 'implementation', summary: 's'.repeat(500), percent: 60, blockers: ['none'], createdAt: now - 1_000 } },
  });

  const result = await request('agents.list', { includeFinishedHours: 24, limit: 1 }) as any;
  expect(result).toEqual({
    generatedAt: expect.any(String),
    agents: [{ channel: 'heartbeat', name: 'Heartbeat', status: 'running', uptimeMs: expect.any(Number), current: expect.any(String) }],
    jobs: [{
      jobId: 'agent-job-live', status: 'running', startedAt: expect.any(String), elapsedMs: expect.any(Number), parentThreadId: 'parent-1',
      tasks: [{
        taskIndex: 0, agentId: 'codex-sol-worker', label: 'Fleet API', status: 'running', visibility: 'tab', threadId: 'thread-live',
        latestCheckin: { step: 'implementation', summary: 's'.repeat(400), percent: 60, blockers: ['none'], time: expect.any(String) },
      }],
    }],
    heartbeat: { enabled: false, status: { isExecuting: false } },
  });
  expect(result.agents[0].current).toHaveLength(400);
  expect(JSON.stringify(result)).not.toContain('private');
  expect(JSON.stringify(result)).not.toContain('agent-job-old');
  await expect(request('agents.list', { includeFinishedHours: 73 })).rejects.toThrow('Invalid includeFinishedHours');
  await expect(request('agents.list', { limit: 0 })).rejects.toThrow('Invalid limit');
});
test('cloud agent controls return clear errors for unknown ids', async() => {
  await expect(request('agents.message', { jobId: 'missing', message: 'hello' })).rejects.toThrow('Agent job "missing" not found');
  await expect(request('agents.stop', { threadId: 'missing' })).rejects.toThrow('Agent thread "missing" not found');
});
test('desktop settings toggle Heartbeat; Projects has no automation switch', async() => {
  await expect(request('desktop.settings.update', { setting: 'projectAutomation', enabled: false })).rejects.toThrow('Invalid');
  expect(set).not.toHaveBeenCalled();
  await request('desktop.settings.update', { setting: 'heartbeat', enabled: true });
  expect(set).toHaveBeenCalledWith('heartbeatEnabled', true, 'boolean');
  expect(set).toHaveBeenCalledTimes(1);
});
test('desktop settings reject unknown keys and non-boolean values', async() => {
  await expect(request('desktop.settings.update', { setting: 'heartbeatEnabled', enabled: true })).rejects.toThrow('Invalid');
  await expect(request('desktop.settings.update', { setting: 'toString', enabled: true })).rejects.toThrow('Invalid');
  await expect(request('desktop.settings.update', { setting: 'heartbeat', enabled: 'false' })).rejects.toThrow('Invalid');
  expect(set).not.toHaveBeenCalled();
});
test('desktop settings read reports the Heartbeat switch only', async() => {
  await expect(request('desktop.settings.read', {})).resolves.toEqual({ heartbeat: false });
});
describe('bookmarks', () => {
  test('lists bookmarks with local flags, trims heavy favicons, and includes Docker links', async() => {
    const result = await request('bookmarks.list', {}) as any;
    expect(result.bookmarks).toEqual([
      expect.objectContaining({ id: 'b1', local: true, favicon: null }),
      expect.objectContaining({ id: 'b2', local: false, favicon: 'data:image/png;base64,AA' }),
    ]);
    expect(result.docker.links).toHaveLength(1);
  });
  test('public bookmarks open directly without a tunnel', async() => {
    await expect(request('bookmarks.open', { url: 'https://docs.example.com/' })).resolves.toEqual({ url: 'https://docs.example.com/', proxied: false });
    expect(openPreview).not.toHaveBeenCalled();
  });
  test('bookmarked and Docker local links open through a preview tunnel', async() => {
    await expect(request('bookmarks.open', { url: 'http://localhost:6152/admin/users' })).resolves.toMatchObject({ proxied: true, url: expect.stringContaining('trycloudflare.com') });
    await request('bookmarks.open', { url: 'http://localhost:8080/' });
    expect(openPreview).toHaveBeenCalledTimes(2);
  });
  test('refuses to tunnel an arbitrary local port', async() => {
    await expect(request('bookmarks.open', { url: 'http://localhost:5432/' })).rejects.toThrow('not a bookmark');
    expect(openPreview).not.toHaveBeenCalled();
  });
  test('close only accepts local URLs', async() => {
    await expect(request('bookmarks.close', { url: 'https://docs.example.com/' })).rejects.toThrow('Local URL');
    await request('bookmarks.close', { url: 'http://localhost:6152/admin' });
    expect(closePreview).toHaveBeenCalledWith('http://localhost:6152');
  });
});

test('models read lists only connected providers and the current primary model', async() => {
  await expect(request('models.read', {})).resolves.toEqual({
    primaryProvider: 'claude-code',
    activeModelId:   'claude-opus-5-5',
    providers:       [{ id: 'claude-code', name: 'Claude Code', connected: true }, { id: 'grok', name: 'Grok', connected: true }],
  });
});
test('models list refuses providers this desktop is not connected to', async() => {
  await expect(request('models.list', { providerId: 'grok' })).resolves.toEqual({ providerId: 'grok', models: [{ id: 'grok-4.6', name: 'Grok 4.6' }] });
  await expect(request('models.list', { providerId: 'openai' })).rejects.toThrow('not connected');
  await expect(request('models.list', { providerId: 'toString' })).rejects.toThrow('not connected');
  await expect(request('models.list', {})).rejects.toThrow('Provider required');
});
test('models select switches the primary model only to a listed model', async() => {
  await request('models.select', { providerId: 'grok', modelId: 'grok-4.6' });
  expect(selectModel).toHaveBeenCalledWith('grok', 'grok-4.6');
  selectModel.mockClear();
  await expect(request('models.select', { providerId: 'grok', modelId: 'made-up-model' })).rejects.toThrow('not available');
  await expect(request('models.select', { providerId: 'grok', modelId: 42 })).rejects.toThrow('not available');
  await expect(request('models.select', { providerId: 'openai', modelId: 'gpt-5' })).rejects.toThrow('not connected');
  expect(selectModel).not.toHaveBeenCalled();
});
