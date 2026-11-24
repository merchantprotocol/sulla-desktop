// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/utils/logging', () => {
  const channel = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { default: new Proxy({}, { get: () => channel }) };
});

import { DetailedTraceUsage } from '../../../database/models/DetailedTraceUsage';
import { createMessageDispatcher } from '../../../database/models/MessageDispatcher';

describe('DetailedTraceUsage dispatch', () => {
  it('captures early token_info on the exact user anchor and preserves normal accounting', () => {
    // risk: usage attribution — a token event may arrive before any assistant transcript event.
    const threadId = 'thread-a';
    const user = { id: 'user-anchor', channelId: 'agent-a', threadId, role: 'user', content: 'Check this' };
    const usage = new DetailedTraceUsage();
    const handleTokenInfo = vi.fn();
    const ctx = {
      messages: [user],
      detailedTraceUsage: usage,
      getThreadId: () => threadId,
      handleTokenInfo,
    } as any;
    const data = {
      tokens_used: 100, prompt_tokens: 70, completion_tokens: 30, time_spent: 250,
      model: 'fixture-model', threadId, runId: 'run-a', nodeId: 'Agent', nodeRunId: 'agent', isSubAgent: false,
    };

    createMessageDispatcher().dispatch(ctx, 'agent-a', threadId, { type: 'token_info', data } as any);

    expect(handleTokenInfo).toHaveBeenCalledExactlyOnceWith(100, 70, 30, 250, threadId, 'Agent');
    expect(usage.value).toHaveLength(1);
    expect(usage.value[0]).toMatchObject({
      afterId: user.id, threadId, runId: 'run-a', nodeId: 'agent', inputTokens: 70, outputTokens: 30,
      durationMs: 250, model: 'fixture-model',
    });
  });

  it('excludes delegated, other-thread, missing-owner, and anchorless samples without changing usage accounting', () => {
    // risk: cross-thread attribution — background/delegated usage must not appear in the active chat trace.
    const threadId = 'thread-a';
    const usage = new DetailedTraceUsage();
    const handleTokenInfo = vi.fn();
    const ctx = {
      messages: [
        { id: 'other-user', channelId: 'agent-a', threadId: 'thread-b', role: 'user', content: 'Other chat' },
        { id: 'user-a', channelId: 'agent-a', threadId, role: 'user', content: 'Current chat' },
      ],
      detailedTraceUsage: usage,
      getThreadId: () => threadId,
      handleTokenInfo,
    } as any;
    const dispatcher = createMessageDispatcher();
    const owned = { tokens_used: 2, prompt_tokens: 1, completion_tokens: 1, time_spent: 1, threadId, runId: 'run-1', nodeId: 'Agent', nodeRunId: 'agent' };

    dispatcher.dispatch(ctx, 'agent-a', threadId, { type: 'token_info', data: { ...owned, isSubAgent: true } } as any);
    dispatcher.dispatch(ctx, 'agent-a', threadId, { type: 'token_info', data: { ...owned, threadId: 'thread-b', runId: 'run-2' } } as any);
    dispatcher.dispatch(ctx, 'agent-a', threadId, { type: 'token_info', data: { ...owned, runId: undefined, nodeRunId: undefined } } as any);
    ctx.messages.splice(1, 1);
    dispatcher.dispatch(ctx, 'agent-a', threadId, { type: 'token_info', data: { ...owned, runId: 'run-4' } } as any);

    expect(usage.value).toEqual([]);
    expect(handleTokenInfo).toHaveBeenCalledTimes(4);
  });

  it('binds a pre-thread user anchor when the backend assigns the initial thread id', () => {
    // risk: usage attribution — the first run must not be lost or attached to a prior thread.
    let threadId: string | undefined;
    const user = { id: 'first-user', channelId: 'agent-a', role: 'user', content: 'First request' };
    const usage = new DetailedTraceUsage();
    const ctx = {
      messages: [user],
      detailedTraceUsage: usage,
      getThreadId: () => threadId,
      setThreadId: (value: string) => { threadId = value },
      handleTokenInfo: vi.fn(),
    } as any;
    const dispatcher = createMessageDispatcher();

    dispatcher.dispatch(ctx, 'agent-a', '', { type: 'thread_created', data: { threadId: 'first-thread' } } as any);
    dispatcher.dispatch(ctx, 'agent-a', 'first-thread', {
      type: 'token_info', data: {
        tokens_used: 9, prompt_tokens: 6, completion_tokens: 3, time_spent: 120,
        threadId: 'first-thread', runId: 'first-run', nodeId: 'Agent', nodeRunId: 'agent',
      },
    } as any);

    expect(user.threadId).toBe('first-thread');
    expect(usage.value[0]).toMatchObject({ afterId: user.id, threadId: 'first-thread', runId: 'first-run' });
  });
});
