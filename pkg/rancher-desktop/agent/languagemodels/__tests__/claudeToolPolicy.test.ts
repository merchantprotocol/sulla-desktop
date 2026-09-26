import { describe, expect, it } from '@jest/globals';

import { isObserverSpawn } from '../claudeToolPolicy';

describe('isObserverSpawn', () => {
  it('locks down subconscious observers', () => {
    expect(isObserverSpawn({ isSubAgent: true, modelSlot: 'subconscious' })).toBe(true);
  });

  it('keeps native actor tools for workflow-node agents stamped primary', () => {
    // PlaybookController sets isSubAgent + modelSlot 'primary' on every
    // workflow agent node; they must keep Bash/Read to run the sulla CLI.
    expect(isObserverSpawn({ isSubAgent: true, modelSlot: 'primary' })).toBe(false);
  });

  it('treats unmarked sub-agents as observers (legacy fail-closed)', () => {
    expect(isObserverSpawn({ isSubAgent: true })).toBe(true);
  });

  it('never locks down the primary chat', () => {
    expect(isObserverSpawn({})).toBe(false);
    expect(isObserverSpawn(undefined)).toBe(false);
  });
});
