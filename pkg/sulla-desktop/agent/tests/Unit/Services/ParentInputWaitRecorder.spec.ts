// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../utils/logging', () => ({ default: { perf: { log: () => undefined } } }));
import { CompletionConsumptionRecorder } from '../../../services/CompletionConsumptionRecorder';
import { ParentInputWaitRecorder } from '../../../services/ParentInputWaitRecorder';
import type { PendingCompletion } from '../../../services/AgentCompletionInbox';
import { injectSteer, markSteerDelivered, markSteerPending } from '../../../utils/steerChannel';

const completion: PendingCompletion = {
  jobId: 'helper-job-1', taskIndex: 0,
  results: [{ label: 'helper', status: 'completed', output: 'private payload must not enter perf logs' }],
};

describe('parent input wait delivery', () => {
  it('computes dwell from the defer timestamp and emits only id/timing metadata', () => {
    // risk: latency measurement accuracy and message privacy
    const lines: string[] = [];
    const recorder = new ParentInputWaitRecorder({ log: line => lines.push(line) }, () => 500);
    const wait = recorder.deferred({ kind: 'completion', threadId: 'parent/thread', inputId: 'helper/job-1#0', queuedAtMs: 100, deferredAtMs: 250 });
    const fallbackWait = recorder.deferred({ kind: 'completion', threadId: 'parent/thread', inputId: 'helper/job-2#0', queuedAtMs: 150, deferredAtMs: 260 });

    expect(wait.inputId).toBe('helper/job-1#0');
    recorder.injected(wait, 300);
    expect(recorder.delivered(wait, 'api_prompt', 425)).toBe(175);
    recorder.injected(fallbackWait, 320);
    expect(recorder.delivered(fallbackWait, 'followup', 460)).toBe(200);
    expect(lines.some(line => line.includes('event=deferred'))).toBe(true);
    expect(lines.some(line => line.includes('event=injected'))).toBe(true);
    expect(lines.some(line => line.includes('event=delivered') && line.includes('boundary=api_prompt'))).toBe(true);
    expect(lines.some(line => line.includes('event=fallback-delivered') && line.includes('boundary=followup'))).toBe(true);
    expect(lines.join('\n')).not.toContain('private payload');
  });

  it('acknowledges a completion once only after the existing graph marks its steer consumed', async() => {
    // risk: duplicate or premature helper-completion acknowledgement
    const state = { messages: [] as any[], metadata: {} };
    const consumption = new CompletionConsumptionRecorder();
    consumption.recordInjected([completion]);
    const recorder = new ParentInputWaitRecorder({ log: () => undefined }, () => 300);
    const parentInputWait = [recorder.deferred({ kind: 'completion', threadId: 'parent-thread', inputId: 'completion:helper-job-1:0', queuedAtMs: 100, deferredAtMs: 200 })];
    let acknowledgements = 0;
    const steer = { role: 'user', content: 'private payload must not enter perf logs', metadata: { source: 'sub_agent_completion', parentInputWaitBoundary: 'followup', completionEntries: [completion], parentInputWait } } as any;
    const boundaries: string[] = [];

    injectSteer(state as any, steer, { onConsumed: (_message, boundary) => { acknowledgements += 1; boundaries.push(boundary); consumption.confirmConsumed([completion]); } });
    expect(state.messages).toHaveLength(1);
    expect(steer.metadata.steerPending).toBe(true);
    expect(acknowledgements).toBe(0);

    markSteerDelivered(steer, 'api_prompt');
    markSteerDelivered(steer, 'api_prompt');
    await Promise.resolve();
    expect(acknowledgements).toBe(1);
    expect(boundaries).toEqual(['followup']);
    const released: PendingCompletion[] = [];
    await consumption.releaseOnAbort(entry => { released.push(entry); });
    expect(released).toEqual([]);
  });

  it('releases a completion whose provider never consumes the steer on Stop/abort', async() => {
    // risk: lost helper completion after Stop or provider abort
    const state = { messages: [] as any[], metadata: {} };
    const consumption = new CompletionConsumptionRecorder();
    consumption.recordInjected([completion]);
    const steer = { role: 'user', content: 'private payload', metadata: { source: 'sub_agent_completion', completionEntries: [completion], parentInputWait: [{ kind: 'completion', threadId: 'parent-thread', inputId: 'completion:helper-job-1:0', queuedAtMs: 100, deferredAtMs: 200 }] } } as any;
    let acknowledgements = 0;

    injectSteer(state as any, steer, { onConsumed: () => { acknowledgements += 1; } });
    markSteerPending(steer);
    const released: PendingCompletion[] = [];
    await consumption.releaseOnAbort(entry => { released.push(entry); });
    expect(acknowledgements).toBe(0);
    expect(released).toEqual([completion]);
  });

  it('does not treat an unrelated later reply as consumption of a still-pending steer', async() => {
    // risk: lost helper completion when an earlier model reply precedes Stop.
    const consumption = new CompletionConsumptionRecorder();
    consumption.recordInjected([completion]);
    consumption.confirmAnswered([
      { role: 'user', metadata: { completionEntries: [completion], steerPending: true } },
      { role: 'assistant', content: 'reply to the original prompt' },
    ]);
    const released: PendingCompletion[] = [];

    await consumption.releaseOnAbort(entry => { released.push(entry); });

    expect(released).toEqual([completion]);
  });

  it('keeps simultaneous human and helper inputs on one existing graph state', () => {
    // risk: concurrent parent inputs starting two graphs or dropping one input
    const state = { messages: [] as any[], metadata: {} };
    const human = { id: 'human-input', role: 'user', content: 'human prompt', metadata: { source: 'human' } } as any;
    const helper = { id: 'helper-input', role: 'user', content: 'helper completion', metadata: { source: 'sub_agent_completion', completionEntries: [completion], parentInputWait: [] } } as any;

    injectSteer(state as any, human);
    injectSteer(state as any, helper);
    expect(state.messages).toHaveLength(2);
    expect(state.messages.map(message => message.id)).toEqual(['human-input', 'helper-input']);
    expect(state.messages.every(message => message.metadata.steerPending)).toBe(true);
  });
});
