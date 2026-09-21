/** @jest-environment node */
import { jest } from '@jest/globals';
import mockModules from '@pkg/utils/testUtils/mockModules';
const getProject = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 'p1', archived: false });
const listTasks = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]);
const set = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined);
const resolveQuestion = jest.fn<(...args: any[]) => boolean>().mockReturnValue(true);
const resolve = jest.fn<(...args: any[]) => boolean>().mockReturnValue(true);
mockModules({
  '@pkg/agent/database/models/WorkItemsModel': { WorkItemsModel: { getProject, listTasks, listProjects: jest.fn(), listRecentActivity: jest.fn<() => Promise<any>>().mockResolvedValue([]) } },
  '@pkg/agent/database/models/WorkLaneDefinitionModel': { WorkLaneDefinitionModel: { resolveEffective: jest.fn<() => Promise<any>>().mockResolvedValue([{ lane_key: 'custom' }]) } },
  '@pkg/agent/database/models/SullaSettingsModel': { SullaSettingsModel: { set, get: jest.fn<() => Promise<any>>().mockResolvedValue(false) } },
  '@pkg/agent/services/HeartbeatService': { getHeartbeatService: () => ({ getStatus: () => ({ isExecuting: false }), getHistory: () => [] }) },
  '@pkg/agent/services/ApprovalService': { ApprovalService: { getInstance: () => ({ resolveQuestion, resolve }) } },
});
const { mobileCompanionRequest: request, registerMobileCard } = await import('@pkg/main/mobileCompanion');
beforeEach(() => { jest.clearAllMocks(); resolveQuestion.mockReturnValue(true); });
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
