/** @jest-environment node */
import { jest } from '@jest/globals';
import mockModules from '@pkg/utils/testUtils/mockModules';
const getProject = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 'p1', archived: false });
const listTasks = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]);
const getTask = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 't1', project_id: 'p1', archived: false });
const listComments = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([{ id: 'c1', body: 'hi' }]);
const addComment = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 'c2', body: 'from phone', author: 'human' });
const set = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined);
const resolveQuestion = jest.fn<(...args: any[]) => boolean>().mockReturnValue(true);
const resolve = jest.fn<(...args: any[]) => boolean>().mockReturnValue(true);
const decisionResolve = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ settled: true, conversationId: 'original' });
mockModules({
  '@pkg/agent/services/DecisionService': { decisionService: { list: jest.fn<() => Promise<any>>().mockResolvedValue([]), resolve: decisionResolve } },
  '@pkg/agent/database/models/WorkItemsModel': { WorkItemsModel: { getProject, listTasks, getTask, listComments, listProjects: jest.fn(), listRecentActivity: jest.fn<() => Promise<any>>().mockResolvedValue([]) } },
  '@pkg/agent/database/models/WorkLaneDefinitionModel': { WorkLaneDefinitionModel: { resolveEffective: jest.fn<() => Promise<any>>().mockResolvedValue([{ lane_key: 'custom' }]) } },
  '@pkg/agent/database/models/SullaSettingsModel': { SullaSettingsModel: { set, get: jest.fn<() => Promise<any>>().mockResolvedValue(false) } },
  '@pkg/agent/services/RoutineConcurrencyPolicy': { MASTER_ENABLED_KEY: 'automatedProjectManagementEnabled' },
  '@pkg/agent/services/HeartbeatService': { getHeartbeatService: () => ({ getStatus: () => ({ isExecuting: false }), getHistory: () => [] }) },
  '@pkg/agent/projects/application/ProjectsApplicationService': { getProjectsApplicationService: () => ({ addComment }) },
  '@pkg/agent/services/ApprovalService': { ApprovalService: { getInstance: () => ({ resolveQuestion, resolve }) } },
});
const { mobileCompanionRequest: request, registerMobileCard } = await import('@pkg/main/mobileCompanion');
beforeEach(() => { jest.clearAllMocks(); resolveQuestion.mockReturnValue(true); getTask.mockResolvedValue({ id: 't1', project_id: 'p1', archived: false }); });
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
test('desktop settings toggle Heartbeat and Projects automation independently', async() => {
  await request('desktop.settings.update', { setting: 'projectAutomation', enabled: false });
  expect(set).toHaveBeenCalledWith('automatedProjectManagementEnabled', false, 'boolean');
  expect(set).toHaveBeenCalledTimes(1);
  set.mockClear();
  await request('desktop.settings.update', { setting: 'heartbeat', enabled: true });
  expect(set).toHaveBeenCalledWith('heartbeatEnabled', true, 'boolean');
  expect(set).toHaveBeenCalledTimes(1);
});
test('desktop settings reject unknown keys and non-boolean values', async() => {
  await expect(request('desktop.settings.update', { setting: 'heartbeatEnabled', enabled: true })).rejects.toThrow('Invalid');
  await expect(request('desktop.settings.update', { setting: 'toString', enabled: true })).rejects.toThrow('Invalid');
  await expect(request('desktop.settings.update', { setting: 'projectAutomation', enabled: 'false' })).rejects.toThrow('Invalid');
  expect(set).not.toHaveBeenCalled();
});
test('desktop settings read reports both switches', async() => {
  await expect(request('desktop.settings.read', {})).resolves.toEqual({ heartbeat: false, projectAutomation: false });
});
