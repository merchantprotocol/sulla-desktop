// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MessageId } from '../../types/chat';
import type { RunState } from '../../models/RunState';
import { TypingIndicatorState, type TypingIndicatorAgent, type TypingIndicatorInput } from './TypingIndicatorState';

const messageId = 'message-1' as MessageId;
const workingAgent = (key: string, state: TypingIndicatorAgent['state'] = 'working'): TypingIndicatorAgent => ({
  key, initials: key.slice(0, 2).toUpperCase(), name: `Agent ${key}`, state, activityKey: `${key}:${state}`,
});

function input(runState: RunState, overrides: Partial<TypingIndicatorInput> = {}): TypingIndicatorInput {
  const activityAt = Date.now();
  return {
    runState,
    agents: [],
    assistantStreaming: false,
    finalReply: false,
    retryAvailable: false,
    activityAt,
    activityKey: `${runState.phase}:${'startedAt' in runState ? runState.startedAt : 'at' in runState ? runState.at : 'idle'}`,
    ...overrides,
  };
}

describe('TypingIndicatorState', () => {
  afterEach(() => vi.useRealTimers());

  it('maps live controller phases to running, streaming, and named tool states', () => {
    const state = new TypingIndicatorState();

    state.update(input({ phase: 'thinking', startedAt: Date.now(), messageId }));
    expect(state.state.kind).toBe('running');
    expect(state.state.bubbleVisible).toBe(true);

    state.update(input({ phase: 'streaming', startedAt: Date.now(), messageId }));
    expect(state.state.kind).toBe('streaming');
    expect(state.state.shouldRender).toBe(false);
    expect(state.state.bubbleVisible).toBe(false);

    state.update(input({ phase: 'thinking', startedAt: Date.now(), messageId }, { assistantStreaming: true }));
    expect(state.state.kind).toBe('streaming');

    state.update(input({ phase: 'tool', startedAt: Date.now(), messageId, tool: 'read_file' }));
    expect(state.state.kind).toBe('tool');
    expect(state.state.toolName).toBe('read_file');
    expect(state.state.bubbleVisible).toBe(true);
    state.dispose();
  });

  it('parks the root only while scoped working agents remain and exposes their avatars', () => {
    const state = new TypingIndicatorState();
    state.update(input({ phase: 'idle' }, {
      agents: [workingAgent('cm'), workingAgent('lx'), workingAgent('wait', 'waiting')],
    }));

    expect(state.state.kind).toBe('parked');
    expect(state.state.shouldRender).toBe(true);
    expect(state.state.bubbleVisible).toBe(false);
    expect(state.state.agents.map(agent => agent.key)).toEqual(['cm', 'lx']);
    state.dispose();
  });

  it('hides after finish or stop and suppresses a live bubble beside a terminal reply', () => {
    const state = new TypingIndicatorState();

    state.update(input({ phase: 'idle' }));
    expect(state.state.kind).toBe('hidden');
    expect(state.state.bubbleVisible).toBe(false);

    state.update(input({ phase: 'thinking', startedAt: Date.now(), messageId }, { finalReply: true }));
    expect(state.state.kind).toBe('hidden');
    expect(state.state.shouldRender).toBe(false);
    expect(state.state.bubbleVisible).toBe(false);

    state.update(input({ phase: 'paused', reason: 'user', at: Date.now() }));
    expect(state.state.kind).toBe('stopped');
    expect(state.state.shouldRender).toBe(true);
    expect(state.state.bubbleVisible).toBe(false);
    state.dispose();
  });

  it('shows retry on errors and keeps the error row separate from the typing bubble', () => {
    const state = new TypingIndicatorState();
    state.update(input({ phase: 'error', message: 'Connection lost', at: Date.now() }, { retryAvailable: true }));

    expect(state.state.kind).toBe('error');
    expect(state.state.errorMessage).toBe('Connection lost');
    expect(state.state.retryAvailable).toBe(true);
    expect(state.state.bubbleVisible).toBe(false);
    state.dispose();
  });

  it('stalls at the approved 60-second threshold and resets on a new run event', () => {
    vi.useFakeTimers();
    const start = 1_700_000_000_000;
    vi.setSystemTime(start);
    const state = new TypingIndicatorState();
    state.update(input({ phase: 'thinking', startedAt: start, messageId }, { activityAt: start, activityKey: 'think:start' }));

    vi.advanceTimersByTime(59_999);
    expect(state.state.kind).toBe('running');
    vi.advanceTimersByTime(1);
    expect(state.state.kind).toBe('stalled');
    expect(state.state.bubbleVisible).toBe(true);

    const nextAt = Date.now();
    state.update(input({ phase: 'tool', startedAt: nextAt, messageId, tool: 'shell' }, { activityAt: nextAt, activityKey: 'tool:shell' }));
    expect(state.state.kind).toBe('tool');
    vi.advanceTimersByTime(59_999);
    expect(state.state.kind).toBe('tool');
    vi.advanceTimersByTime(1);
    expect(state.state.kind).toBe('stalled');
    expect(state.state.toolName).toBe('shell');
    state.dispose();
  });
});
