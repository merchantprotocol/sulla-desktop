// SPDX-License-Identifier: GPL-2.0-or-later
// The graph's model resolution must hand its run Stop handle to a worker route catalog wait.
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeferredStallInput } from '../../../app/Services/DeferredStallInput';
import { completionInboxStore } from '../../../services/AgentCompletionInbox';
import { injectSteer } from '../../../utils/steerChannel';
import { BaseNode } from '../../../nodes/BaseNode';
import { AbortService } from '../../../services/AbortService';
import { agentDefinitionService } from '../../../services/AgentDefinitionService';
import { workerModelRouting } from '../../../services/WorkerModelRouting';
import { agentJobProvider } from '../../../app/Providers/AgentJobServiceProvider';

import type { BaseThreadState, NodeResult } from '../../../nodes/Graph';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

class RouteProbeNode extends BaseNode {
  constructor() { super('route-probe', 'Route probe') }
  async execute(state: BaseThreadState): Promise<NodeResult<BaseThreadState>> { return { state, decision: { type: 'end' } } as any }
  resolve(state: BaseThreadState) { return this.resolveLoopProvider(state) }
}

const route = { version: 1, slug: 'luna', agentId: 'luna-id', revision: 1, selected: 0, candidates: [{ provider: 'codex', model: 'gpt-6-luna' }] };
const stateWith = (abort: unknown): BaseThreadState => ({ metadata: { threadId: 't', agentId: 'luna', options: { abort }, workerModelRoute: structuredClone(route) }, messages: [] }) as any;

afterEach(() => { vi.restoreAllMocks() });

describe('graph model resolution Stop propagation for worker routes', () => {
  it.each([
    ['an AbortService run handle', () => { const handle = new AbortService(); return { handle, signal: handle.signal, stop: () => handle.abort() } }],
    ['a raw AbortSignal run handle', () => { const controller = new AbortController(); return { handle: controller.signal, signal: controller.signal, stop: () => controller.abort() } }],
  ])('ends the catalog wait when %s is stopped', async(_label, make) => {
    const run = make();
    let received: AbortSignal | undefined;
    vi.spyOn(agentDefinitionService, 'findBySlug').mockResolvedValue({ id: 'luna-id', slug: 'luna' } as any);
    vi.spyOn(workerModelRouting, 'resolveRoute').mockImplementation((_route, signal) => {
      received = signal;
      // Behaves like a catalog outage: settles only when the run is stopped.
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true }));
    });
    const resolving = new RouteProbeNode().resolve(stateWith(run.handle));
    await vi.waitFor(() => expect(received).toBe(run.signal));
    run.stop();
    await expect(resolving).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('resolved model decision persistence', () => {
  it('updates the task when BaseNode advances to a fallback candidate', async() => {
    // risk: the job audit says the failed first model ran instead of the fallback that was tried
    const node = new RouteProbeNode();
    const mutate = vi.spyOn(agentJobProvider.states, 'mutateJob').mockResolvedValue({} as any);
    const state = stateWith(undefined) as any;
    state.metadata.modelDecisionTask = { jobId: 'fallback-job', taskIndex: 0, generation: 1, threadId: 't' };
    state.metadata.modelDecision = { requested: null, ran: { provider: 'codex', model: 'gpt-first' }, step: 'category' };
    const service = { getProviderName: () => 'claude-code', getModel: () => 'claude-fallback' };
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});

    await (node as any).persistModelDecision(state, service, 'Fallback after codex/gpt-first failed: unavailable');

    expect(mutate).toHaveBeenCalledWith('fallback-job', expect.any(Function), undefined, false);
    const update = mutate.mock.calls[0][1] as (job: any) => any;
    const saved = update({ status: 'running', tasks: [{ status: 'running', threadId: 't', generation: 1 }] });
    expect(saved.tasks[0].modelDecision).toEqual({
      requested: null,
      ran: { provider: 'claude-code', model: 'claude-fallback' },
      step: 'category',
      reason: 'Fallback after codex/gpt-first failed: unavailable',
    });
    expect(log).toHaveBeenCalledWith('[ModelPrecedence] job=fallback-job requested=none ran=claude-code/claude-fallback step=category');
  });
});

describe('deferred stall input at the model boundary', () => {
  it.each(['assistant', 'user', 'tool'] as const)('does not send an expired stall over a historical %s tail, and leaves a newer steer pending', async(role) => {
    // risk: false stall reaches the parent after the child settled; unrelated input is lost.
    const node = new RouteProbeNode();
    const ws = vi.spyOn(node as any, 'wsChatMessage').mockResolvedValue(undefined);
    const state = stateWith(undefined);
    state.messages.push({ role, content: 'waiting for the child' });
    injectSteer(state, {
      role: 'user', content: '', metadata: DeferredStallInput.metadata('parent', 't', [{
        jobId: 'running', taskIndex: 0, results: [], noticeKind: 'stall', stall: { childThread: 'child', baseline: 'old' },
      }]),
    });
    const snapshot = [...state.messages];
    let current = true;
    const validation = vi.spyOn(completionInboxStore, 'currentEntries')
      .mockImplementation(async(_channel, _threadId, entries) => current ? entries : []);
    const chatStream = vi.fn();
    const provider = {
      getModel: () => 'test', chatStream,
      getAccountId: async() => {
        current = false; // The child settles while the provider/container is being prepared.
        injectSteer(state, { role: 'user', content: 'unrelated new steer' });
        return undefined;
      },
    };
    const reply = await (node as any).callLLMStreaming(state, snapshot, {}, {}, provider);
    expect(validation).toHaveBeenCalledOnce();
    expect(chatStream).not.toHaveBeenCalled();
    expect(ws).not.toHaveBeenCalled();
    expect(reply.metadata.reusedAssistantMessage).toBe(true);
    expect(state.messages.map(message => message.content)).toEqual(['waiting for the child', 'unrelated new steer']);
    expect(state.messages[1].metadata?.steerPending).toBe(true);
  });
  it('revalidates a notice on retry without losing the genuine prompt or taking a concurrent steer', async() => {
    // risk: either stale text reaches a provider or current human input is swallowed.
    const node = new RouteProbeNode();
    vi.spyOn(node as any, 'wsChatMessage').mockResolvedValue(undefined);
    const state = stateWith(undefined);
    DeferredStallInput.appendActionable(state, { role: 'user', content: 'genuine new prompt' });
    injectSteer(state, {
      role: 'user', content: '', metadata: DeferredStallInput.metadata('parent', 't', [{
        jobId: 'running', taskIndex: 0, results: [], noticeKind: 'stall', stall: { childThread: 'child', baseline: 'old' },
      }]),
    });
    const snapshot = [...state.messages];
    const validation = vi.spyOn(completionInboxStore, 'currentEntries')
      .mockImplementationOnce(async(_channel, _thread, entries) => entries)
      .mockResolvedValueOnce([]);
    const chatStream = vi.fn().mockRejectedValueOnce(new Error('temporary response failure'))
      .mockResolvedValueOnce({ content: 'answered', metadata: {} });
    const provider = { getModel: () => 'test', chatStream };
    await expect((node as any).callLLMStreaming(state, snapshot, {}, {}, provider)).rejects.toThrow('temporary response failure');
    injectSteer(state, { role: 'user', content: 'newer steer' });

    await (node as any).callLLMStreaming(state, snapshot, {}, {}, provider);

    expect(validation).toHaveBeenCalledTimes(2);
    expect(chatStream.mock.calls[1][0].map((message: { content: string }) => message.content)).toEqual(['genuine new prompt']);
    expect(state.messages.at(-1)?.metadata?.steerPending).toBe(true);
  });

});
