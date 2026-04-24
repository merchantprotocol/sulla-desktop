import { describe, it, expect } from '@jest/globals';

import { nextRunState, type RunEvent } from '../runStateMachine';
import type { RunState } from '../../models/RunState';
import { newMessageId } from '../../types/chat';

const mid = () => newMessageId();

describe('runStateMachine', () => {
  it('idle → thinking on send', () => {
    const s0: RunState = { phase: 'idle' };
    const next = nextRunState(s0, { type: 'send', messageId: mid() });
    expect(next.phase).toBe('thinking');
  });

  it('thinking → tool on spawnTool', () => {
    const s0: RunState = { phase: 'thinking', startedAt: 0, messageId: mid() };
    const next = nextRunState(s0, { type: 'spawnTool', messageId: mid(), tool: 'Grep' });
    expect(next.phase).toBe('tool');
  });

  it('tool → thinking on toolDone', () => {
    const s0: RunState = { phase: 'tool', startedAt: 0, messageId: mid(), tool: 'Grep' };
    const next = nextRunState(s0, { type: 'toolDone' });
    expect(next.phase).toBe('thinking');
  });

  it('thinking → streaming on stream', () => {
    const s0: RunState = { phase: 'thinking', startedAt: 0, messageId: mid() };
    const next = nextRunState(s0, { type: 'stream', messageId: mid() });
    expect(next.phase).toBe('streaming');
  });

  it('streaming → idle on streamEnd', () => {
    const s0: RunState = { phase: 'streaming', startedAt: 0, messageId: mid() };
    const next = nextRunState(s0, { type: 'streamEnd' });
    expect(next.phase).toBe('idle');
  });

  it('any → paused on stop', () => {
    const states: RunState[] = [
      { phase: 'idle' },
      { phase: 'thinking', startedAt: 0, messageId: mid() },
      { phase: 'streaming', startedAt: 0, messageId: mid() },
    ];
    for (const s of states) {
      const next = nextRunState(s, { type: 'stop' });
      expect(next.phase).toBe('paused');
    }
  });

  it('paused(limit) → thinking on continue', () => {
    const s0: RunState = { phase: 'paused', reason: 'limit', at: 0 };
    const next = nextRunState(s0, { type: 'continue' });
    expect(next.phase).toBe('thinking');
  });

  it('paused(user) ignores continue', () => {
    const s0: RunState = { phase: 'paused', reason: 'user', at: 0 };
    const next = nextRunState(s0, { type: 'continue' });
    expect(next.phase).toBe('paused');
  });

  it('invalid transitions return the current state', () => {
    const s0: RunState = { phase: 'idle' };
    const next = nextRunState(s0, { type: 'toolDone' });
    expect(next).toBe(s0);
  });
});
