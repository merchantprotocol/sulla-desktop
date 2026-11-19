// SPDX-License-Identifier: GPL-2.0-or-later
// A mapped worker chat whose provider catalog is temporarily unavailable waits in the
// container pre-check. The user's Stop must end that wait through the turn's own run handle.
import { describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ createAgentContainerLifecycle: vi.fn(), saveThreadState: vi.fn(() => Promise.resolve()) }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../services/ModelProviderService', () => ({ getModelProviderService: () => ({ isInitialized: () => true, getPrimaryProvider: () => 'codex' }) }));
vi.mock('../../../services/AgentContainerLauncher', () => ({ createAgentContainerLifecycle: f.createAgentContainerLifecycle }));
vi.mock('../../../nodes/ThreadStateStore', () => ({ loadThreadState: vi.fn(() => Promise.resolve(null)), saveThreadState: f.saveThreadState }));
vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: vi.fn(), releaseChatActivity: vi.fn() }));
vi.mock('@pkg/main/firstRun/firstRunTrace', () => ({ firstRunTrace: vi.fn() }));
vi.mock('../../../services/AgentCompletionInbox', async() => ({
  ...await vi.importActual<object>('../../../services/AgentCompletionInbox'),
  takeAgentCompletions: vi.fn(() => []),
  setCompletionInboxStopped: vi.fn(),
}));

const CHANNEL = 'mapped-worker';
const THREAD = 'mapped-worker-thread';
const route = { version: 1, slug: CHANNEL, agentId: 'mapped-worker-id', revision: 2, selected: 0, connections: { codex: 'codex-subscription' }, candidates: [{ provider: 'codex', model: 'gpt-6-luna', effort: 'max' }] };

async function harness() {
  const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
  const { GraphRegistry } = await import('../../../services/GraphRegistry');
  const { parkedAgentRehydrator } = await import('../../../services/ParkedAgentRehydrator');
  const { agentDefinitionService } = await import('../../../services/AgentDefinitionService');
  const { modelRouter } = await import('../../../languagemodels/modelRouter');
  const state: any = { metadata: { threadId: THREAD, agentId: CHANNEL, agent: {}, options: {}, workerModelRoute: structuredClone(route) }, messages: [] };
  const graph = { execute: vi.fn() };
  vi.spyOn(GraphRegistry, 'getOrCreateAgentGraph').mockResolvedValue({ graph, state } as any);
  vi.spyOn(parkedAgentRehydrator, 'resolve').mockResolvedValue(null);
  vi.spyOn(agentDefinitionService, 'findBySlug').mockResolvedValue({ id: 'mapped-worker-id', slug: CHANNEL, run_location: 'container' } as any);
  // The connected Codex subscription reports no models: a live-catalog outage, not an owner change.
  const providerInfo = vi.spyOn(modelRouter, 'providerInfo').mockResolvedValue([{ id: 'codex', connected: true, models: [] }] as any);
  vi.spyOn(modelRouter, 'getEditableState').mockResolvedValue({ neverUse: [] } as any);
  const service = Object.create(BackendGraphWebSocketService.prototype) as any;
  const sent: any[] = [];
  Object.assign(service, { runLocationResolver: { resolve: () => 'container' }, activeAborts: new Map(), resumeContexts: new Map(), conversationContainers: new Map(), wsService: { send: (_channel: string, msg: any) => { sent.push(msg); return true } } });
  return { service, state, graph, sent, providerInfo };
}

describe('Stop during a worker route catalog wait', () => {
  it('ends the waiting turn through its own run handle without launching or reporting an error', async() => {
    const { service, state, graph, sent, providerInfo } = await harness();
    const turn = service.executeReadyTurn(CHANNEL, CHANNEL, 'continue the review', THREAD, undefined, CHANNEL, 'keyboard');
    await vi.waitFor(() => expect(providerInfo).toHaveBeenCalled());
    const runHandle = service.activeAborts.get(service.abortKey(CHANNEL, THREAD));
    expect(runHandle?.signal.aborted).toBe(false);

    const stoppedAt = Date.now();
    await service.handleChannelMessage(CHANNEL, CHANNEL, { type: 'stop_run', data: { threadId: THREAD } });

    // Without the run signal this would sit for the five-minute catalog wait.
    await expect(turn).resolves.toBe('failed');
    expect(Date.now() - stoppedAt).toBeLessThan(2_000);
    expect(runHandle.signal.aborted).toBe(true);
    expect(f.createAgentContainerLifecycle).not.toHaveBeenCalled();
    expect(graph.execute).not.toHaveBeenCalled();
    expect(sent.filter(msg => msg.type === 'assistant_message' && String(msg.data?.content).startsWith('Agent error'))).toEqual([]);
    expect(state.metadata).toMatchObject({ cycleComplete: true, waitingForUser: true });
    // The route stays approved and unchanged for the next turn.
    expect(state.metadata.workerModelRoute).toEqual(route);
    expect(service.activeAborts.has(service.abortKey(CHANNEL, THREAD))).toBe(false);
  });
});
