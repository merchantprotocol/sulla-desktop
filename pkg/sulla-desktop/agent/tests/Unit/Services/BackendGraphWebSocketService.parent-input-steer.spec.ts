// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../../utils/logging', () => ({ default: { perf: { log: () => undefined } } }));
vi.mock('../../../utils/agentLogger', () => ({ frontendGraphLogger: console }));
vi.mock('../../../app/Providers/AgentJobServiceProvider', () => ({ agentJobProvider: {
  jobs: { markTaskCompletionFirstDelivered: vi.fn(async() => undefined) },
  completionAcknowledgements: { acknowledge: vi.fn(async() => undefined), release: vi.fn(async() => undefined) },
} }));
vi.mock('../../../database/models/AgentJobMessagingModel', () => ({ AgentJobMessagingModel: {
  markMessagesDelivered: vi.fn(async() => undefined), pendingMessagesForThread: vi.fn(async() => []),
} }));

import { CompletionConsumptionRecorder } from '../../../services/CompletionConsumptionRecorder';
import { ParentInputWaitRecorder } from '../../../services/ParentInputWaitRecorder';
import { awaitSteerAcknowledgements, takePendingSteers, injectSteer, markSteerDelivered } from '../../../utils/steerChannel';

const entry = { jobId: 'child-job', taskIndex: 0, results: [{ label: 'worker', status: 'completed' as const, output: 'ready' }] };

async function activeService() {
  const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
  const { GraphRegistry } = await import('../../../services/GraphRegistry');
  const state = { messages: [] as any[], metadata: { runId: 'existing-run' } };
  const getGraph = vi.spyOn(GraphRegistry, 'get').mockReturnValue({ graph: {} as any, state: state as any } as any);
  const service = Object.create(BackendGraphWebSocketService.prototype) as any;
  const key = 'sulla-desktop|parent-thread';
  service.activeAborts = new Map([[key, {}]]);
  service.activeCompletionConsumptions = new Map([[key, new CompletionConsumptionRecorder()]]);
  service.parentInputWaitRecorder = new ParentInputWaitRecorder({ log: () => undefined }, () => 1000);
  service.agentInbox = {
    acknowledgeEntries: vi.fn(async() => undefined),
    render: (entries: any[]) => entries.map(entry => entry.envelope.body).join('\n\n==========\n\n'),
  };
  service.orchestratorMessageFormatter = { format: (message: string) => `[Message from orchestrator]\n${ message }` };
  service.dispatchToAgent = vi.fn();
  return { service, state, getGraph };
}

describe('busy parent input handoff', () => {
  it('injects one helper completion into the active graph and leaves exactly one post-run fallback if unseen', async() => {
    // risk: duplicate completion delivery or a second graph on the same thread
    const { service, state, getGraph } = await activeService();
    const metadata = { source: 'sub_agent_completion', completionEntries: [entry] };
    const ids = ['completion:child-job:0'];

    expect(await Promise.all([
      service.injectActiveParentInput('sulla-desktop', 'parent-thread', 'completion', 'worker ready', metadata, ids, [entry]),
      service.injectActiveParentInput('sulla-desktop', 'parent-thread', 'completion', 'worker ready', metadata, ids, [entry]),
    ])).toEqual([true, true]);

    expect(getGraph).toHaveBeenCalledTimes(2);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].metadata.completionEntries).toEqual([entry]);
    const followups = takePendingSteers(state as any);
    expect(followups).toHaveLength(1);
    expect(followups[0].metadata.completionEntries).toEqual([entry]);
    const released: any[] = [];
    service.activeCompletionConsumptions.get('sulla-desktop|parent-thread').handoff([entry]);
    await service.activeCompletionConsumptions.get('sulla-desktop|parent-thread').releaseOnAbort((completion: any) => { released.push(completion) });
    expect(released).toEqual([]);
    expect(service.dispatchToAgent).not.toHaveBeenCalled();
    getGraph.mockRestore();
  });

  it('preserves completion arrival order when several helpers finish during one active turn', async() => {
    // risk: reordered helper results can make the parent act on stale information.
    const { service, state, getGraph } = await activeService();
    const first = { ...entry, jobId: 'first-helper' };
    const second = { ...entry, jobId: 'second-helper' };

    expect(service.injectActiveParentInput('sulla-desktop', 'parent-thread', 'completion', 'first', {
      source: 'sub_agent_completion', completionEntries: [first],
    }, ['completion:first-helper:0'], [first])).toBe(true);
    expect(service.injectActiveParentInput('sulla-desktop', 'parent-thread', 'completion', 'second', {
      source: 'sub_agent_completion', completionEntries: [second],
    }, ['completion:second-helper:0'], [second])).toBe(true);

    expect(state.messages.map(message => message.metadata.completionEntries[0].jobId)).toEqual(['first-helper', 'second-helper']);
    getGraph.mockRestore();
  });

  it('rejects a steer that loses the finish race so the caller can deliver its durable fallback', async() => {
    // risk: a completion arriving as a run ends must be delivered once, not stranded between active and idle paths.
    const { service, state, getGraph } = await activeService();
    const accepted = service.injectActiveParentInput('sulla-desktop', 'parent-thread', 'completion', 'in-flight', {
      source: 'sub_agent_completion', completionEntries: [entry],
    }, ['completion:child-job:0'], [entry]);
    service.activeAborts.clear(); // models the run-end transition before the next inbox wake.
    const raced = service.injectActiveParentInput('sulla-desktop', 'parent-thread', 'completion', 'run ended', {
      source: 'sub_agent_completion', completionEntries: [{ ...entry, jobId: 'raced-child' }],
    }, ['completion:raced-child:0'], [{ ...entry, jobId: 'raced-child' }]);

    expect(accepted).toBe(true);
    expect(raced).toBe(false);
    expect(takePendingSteers(state as any).map(message => message.content)).toEqual(['in-flight']);
    getGraph.mockRestore();
  });

  it('keeps a simultaneous human send and helper completion in the same active state', async() => {
    // risk: a same-thread arrival race superseding one input with a parallel graph
    const { service, state, getGraph } = await activeService();

    const completionSteer = service.injectActiveParentInput(
      'sulla-desktop', 'parent-thread', 'completion', 'worker ready',
      { source: 'sub_agent_completion', completionEntries: [entry] }, ['completion:child-job:0'], [entry],
    );
    injectSteer(state as any, { id: 'human-input', role: 'user', content: 'human prompt', metadata: { source: 'human' } } as any);
    expect(await completionSteer).toBe(true);

    expect(state.messages).toHaveLength(2);
    expect(state.messages.map(message => message.metadata.source).sort()).toEqual(['human', 'sub_agent_completion'].sort());
    expect(state.messages.filter(message => message.metadata.source === 'human')).toHaveLength(1);
    expect(state.messages.filter(message => message.metadata.source === 'sub_agent_completion')).toHaveLength(1);
    expect(service.dispatchToAgent).not.toHaveBeenCalled();
    getGraph.mockRestore();
  });

  it('does not put a provider-consumed completion back into the run-end drain', async() => {
    // risk: exactly-once helper delivery across provider boundary and run-end fallback
    const { service, state, getGraph } = await activeService();
    const metadata = { source: 'sub_agent_completion', completionEntries: [entry] };
    expect(await service.injectActiveParentInput('sulla-desktop', 'parent-thread', 'completion', 'worker ready', metadata, ['completion:child-job:0'], [entry])).toBe(true);

    markSteerDelivered(state.messages[0], 'api_prompt');
    await awaitSteerAcknowledgements(state as any);
    expect(takePendingSteers(state as any)).toEqual([]);
    expect(service.activeCompletionConsumptions.get('sulla-desktop|parent-thread').hasPending(entry)).toBe(false);
    expect(service.dispatchToAgent).not.toHaveBeenCalled();
    getGraph.mockRestore();
  });

  it('steers an eligible inbox message into the active graph and acknowledges only at the boundary', async() => {
    // risk: system inbox delivery without a second graph or premature acknowledgement
    const { service, state, getGraph } = await activeService();
    const inboxEntry = { queuedAtMs: 500, target: { channel: 'sulla-desktop', threadId: 'parent-thread' }, envelope: { kind: 'peer', from: 'mobile-relay', body: 'status', ids: { messageId: 'inbox-42' } } };

    expect(await service.wakeInbox({ channel: 'sulla-desktop', threadId: 'parent-thread' }, 'status', [inboxEntry])).toBe('deferred');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].metadata.parentInputWait[0]).toMatchObject({ kind: 'agent_inbox', inputId: 'inbox-42', queuedAtMs: 500 });
    expect(service.agentInbox.acknowledgeEntries).not.toHaveBeenCalled();
    expect(service.dispatchToAgent).not.toHaveBeenCalled();

    markSteerDelivered(state.messages[0], 'api_prompt');
    await vi.waitFor(() => expect(service.agentInbox.acknowledgeEntries).toHaveBeenCalledWith({ channel: 'sulla-desktop', threadId: 'parent-thread' }, ['inbox-42']));
    getGraph.mockRestore();
  });

  it('steers eligible channel rows from a mixed inbox batch without consuming human/decision rows', async() => {
    // risk: an unrelated decision entry must not keep a peer message queued behind a busy parent.
    const { service, state, getGraph } = await activeService();
    const peer = { queuedAtMs: 500, target: { channel: 'sulla-desktop', threadId: 'parent-thread' }, envelope: { kind: 'peer', from: 'mobile-relay', body: 'peer status', ids: { messageId: 'inbox-peer' } } };
    const decision = { queuedAtMs: 501, target: { channel: 'sulla-desktop', threadId: 'parent-thread' }, envelope: { kind: 'decision', from: 'human', body: 'approve?', ids: { messageId: 'inbox-decision' } } };

    expect(await service.wakeInbox({ channel: 'sulla-desktop', threadId: 'parent-thread' }, 'mixed', [peer, decision])).toBe('deferred');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe('peer status');
    expect(state.messages[0].metadata.parentInputWait.map((wait: any) => wait.inputId)).toEqual(['inbox-peer']);
    getGraph.mockRestore();
  });

  it('injects a parked orchestrator wake into the active graph without dispatching a second run', async() => {
    // risk: manager-message loss or parallel graphs on a busy parent thread
    const { service, state, getGraph } = await activeService();
    service.orchestratorMessageFormatter = { format: (message: string) => `[Message from orchestrator]\n${ message }` };

    expect(await service.wakeParkedAgent('sulla-desktop', 'parent-thread', 'manager update', undefined, {
      jobMessageId: 'job-message-7', jobMessageThreadId: 'parent-thread', jobMessageKind: 'orchestrator',
    })).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].metadata.parentInputWait[0]).toMatchObject({ kind: 'orchestrator', inputId: 'job-message-7', threadId: 'parent-thread' });
    expect(state.messages[0].content).toContain('manager update');
    expect(service.dispatchToAgent).not.toHaveBeenCalled();
    getGraph.mockRestore();
  });

  it('routes a busy manager message through the shared boundary acknowledgement path', async() => {
    // risk: a queued manager message must remain durable until the active provider consumes it.
    const { service, state, getGraph } = await activeService();
    const { AgentJobMessagingModel } = await import('../../../database/models/AgentJobMessagingModel');
    vi.mocked(AgentJobMessagingModel.markMessagesDelivered).mockClear();

    expect(service.steerOrchestratorMessageIfBusy('sulla-desktop', 'parent-thread', 'manager update', {
      jobMessageId: 'job-message-8', jobMessageThreadId: 'parent-thread', jobMessageKind: 'orchestrator',
    })).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toContain('manager update');
    expect(state.messages[0].metadata.parentInputWait[0]).toMatchObject({ kind: 'orchestrator', inputId: 'job-message-8' });
    expect(AgentJobMessagingModel.markMessagesDelivered).not.toHaveBeenCalled();

    markSteerDelivered(state.messages[0], 'api_prompt');
    await awaitSteerAcknowledgements(state as any);
    expect(AgentJobMessagingModel.markMessagesDelivered).toHaveBeenCalledWith(['job-message-8'], 'parent-thread');
    getGraph.mockRestore();
  });

  it('still wakes an active delegated runner when the system event has no message id', async() => {
    // risk: a timer wake without a durable message id must not be dropped.
    const { service, state, getGraph } = await activeService();
    service.orchestratorMessageFormatter = { format: (message: string) => message };

    expect(await service.wakeParkedAgent('sulla-desktop', 'parent-thread', 'wait complete', undefined, {
      jobId: 'wait-job', taskIndex: 0, source: 'agent_wait_timer',
    })).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe('wait complete');
    expect(state.messages[0].metadata.parentInputWait).toBeUndefined();
    expect(service.dispatchToAgent).not.toHaveBeenCalled();
    getGraph.mockRestore();
  });

  it('removes only unconsumed A4 steers on abort so durable sources retry without replaying a duplicate copy', async() => {
    // risk: duplicate delivery after Stop/abort and durable requeue.
    const { service, state, getGraph } = await activeService();
    const systemSteer = { id: 'system', role: 'user', content: 'status', metadata: { steerPending: true, parentInputWait: [{ kind: 'agent_inbox', inputId: 'inbox-1' }] } };
    const humanSteer = { id: 'human', role: 'user', content: 'human', metadata: { steerPending: true, source: 'human' } };
    state.messages.push(systemSteer, humanSteer);

    service.releaseUnconsumedParentInputSteers(state as any);

    expect(state.messages).toEqual([humanSteer]);
    getGraph.mockRestore();
  });

  it('routes a system inbox wake to a live delegated runner instead of a new graph', async() => {
    // risk: second graph competing with a parked in-process manager runner
    const { service, state, getGraph } = await activeService();
    service.activeAborts.clear();
    state.metadata.delegatedRunActive = true;
    const inboxEntry = { queuedAtMs: 700, target: { channel: 'sulla-desktop', threadId: 'parent-thread' }, envelope: { kind: 'peer', from: 'mobile-relay', body: 'status', ids: { messageId: 'inbox-73' } } };

    expect(await service.wakeInbox({ channel: 'sulla-desktop', threadId: 'parent-thread' }, 'status', [inboxEntry])).toBe('deferred');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].metadata.parentInputWait[0]).toMatchObject({ kind: 'agent_inbox', inputId: 'inbox-73' });
    expect(service.dispatchToAgent).not.toHaveBeenCalled();
    getGraph.mockRestore();
  });
});
