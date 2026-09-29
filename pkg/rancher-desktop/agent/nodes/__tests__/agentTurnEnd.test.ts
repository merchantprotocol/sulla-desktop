import { describe, expect, it } from '@jest/globals';

import { isTerminalAgentTurn } from '../agentTurnEnd';

describe('isTerminalAgentTurn', () => {
  it('ends on explicit done or blocked', () => {
    expect(isTerminalAgentTurn('done', false)).toBe(true);
    expect(isTerminalAgentTurn('blocked', true)).toBe(true);
  });

  it('ends a wrapper-less reply with no in-graph tool calls (CLI providers)', () => {
    expect(isTerminalAgentTurn('in_progress', false)).toBe(true);
  });

  it('does not end while the loop will come back for another pass', () => {
    expect(isTerminalAgentTurn('in_progress', true)).toBe(false);
    expect(isTerminalAgentTurn('continue', false)).toBe(false);
  });
});
