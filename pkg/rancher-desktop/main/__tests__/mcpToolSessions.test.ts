import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ToolSessionRegistry } from '../mcpToolSessions';

import type { BaseThreadState } from '@pkg/agent/nodes/Graph';

const TTL = 10 * 60_000;
const stateA = { metadata: { threadId: 'a' } } as unknown as BaseThreadState;
const stateB = { metadata: { threadId: 'b' } } as unknown as BaseThreadState;

describe('ToolSessionRegistry ("Expired tool session")', () => {
  beforeEach(() => { jest.useFakeTimers({ now: 1_000_000 }) });
  afterEach(() => { jest.useRealTimers() });

  it('slides expiry on use so a long, active turn never times out mid-turn', () => {
    const sessions = new ToolSessionRegistry();
    const id = sessions.register(stateA, TTL);

    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(TTL - 60_000);
      expect(sessions.get(id)?.state).toBe(stateA);
    }
  });

  it('still expires a session left unused past its TTL', () => {
    const sessions = new ToolSessionRegistry();
    const id = sessions.register(stateA, TTL);

    jest.advanceTimersByTime(TTL + 1);
    expect(sessions.get(id)).toBeNull();
  });

  it('revives a reaped warm-pool token under the same id on rebind', () => {
    const sessions = new ToolSessionRegistry();
    const id = sessions.register(stateA, TTL);

    jest.advanceTimersByTime(TTL + 1);
    sessions.sweepExpired();
    expect(sessions.get(id)).toBeNull();

    expect(sessions.rebind(id, stateB)).toBe(true);
    expect(sessions.get(id)?.state).toBe(stateB);
  });

  it('keeps the session\'s own TTL on rebind instead of resetting to the default', () => {
    const sessions = new ToolSessionRegistry();
    const id = sessions.register(stateA, 4 * 60 * 60_000);

    sessions.rebind(id, stateB);
    jest.advanceTimersByTime(TTL * 3);
    expect(sessions.get(id)?.state).toBe(stateB);
  });

  it('does not resolve a revoked token', () => {
    const sessions = new ToolSessionRegistry();
    const id = sessions.register(stateA, TTL);

    sessions.revoke(id);
    expect(sessions.get(id)).toBeNull();
  });
});
