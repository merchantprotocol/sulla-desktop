/** @jest-environment node */
import { jest } from '@jest/globals';
import mockModules from '@pkg/utils/testUtils/mockModules';
const getProject = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 'p1', archived: false });
const listTasks = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]);
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
const realLoopback = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url);
mockModules({
  '@pkg/agent/services/DecisionService': { decisionService: { list: jest.fn<() => Promise<any>>().mockResolvedValue([]), resolve: decisionResolve } },
  '@pkg/agent/database/models/WorkItemsModel': { WorkItemsModel: { getProject, listTasks, listProjects: jest.fn(), listRecentActivity: jest.fn<() => Promise<any>>().mockResolvedValue([]) } },
  '@pkg/agent/database/models/WorkLaneDefinitionModel': { WorkLaneDefinitionModel: { resolveEffective: jest.fn<() => Promise<any>>().mockResolvedValue([{ lane_key: 'custom' }]) } },
  '@pkg/agent/database/models/SullaSettingsModel': { SullaSettingsModel: { set, get: jest.fn<() => Promise<any>>().mockResolvedValue(false) } },
  '@pkg/agent/services/HeartbeatService': { getHeartbeatService: () => ({ getStatus: () => ({ isExecuting: false }), getHistory: () => [] }) },
  '@pkg/agent/services/ApprovalService': { ApprovalService: { getInstance: () => ({ resolveQuestion, resolve }) } },
  '@pkg/agent/database/models/BrowserBookmarkModel': { BrowserBookmarkModel: { list: listBookmarks } },
  '@pkg/main/dockerLinks': { listDockerLinks },
  '@pkg/main/previewShare': { isLoopbackUrl: realLoopback, previewShares: { open: openPreview, close: closePreview } },
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
