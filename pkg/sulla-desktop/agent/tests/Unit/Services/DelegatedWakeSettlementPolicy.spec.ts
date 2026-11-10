import { describe, expect, it } from 'vitest';
import { DelegatedWakeSettlementPolicy } from '../../../services/DelegatedWakeSettlementPolicy';

describe('DelegatedWakeSettlementPolicy', () => {
  const policy = new DelegatedWakeSettlementPolicy();

  it('parks an empty wake while a child is live, then fails on the third consecutive empty wake', () => {
    // risk: lost delegated work
    expect(policy.shouldPark({ liveChildren: 1, pendingWait: false, consecutiveEmptyWakes: 1 })).toBe(true);
    expect(policy.shouldPark({ liveChildren: 1, pendingWait: false, consecutiveEmptyWakes: 2 })).toBe(true);
    expect(policy.shouldPark({ liveChildren: 1, pendingWait: false, consecutiveEmptyWakes: 3 })).toBe(false);
  });

  it('fails an empty wake with no live child or pending wait', () => {
    // risk: lost delegated work
    expect(policy.shouldPark({ liveChildren: 0, pendingWait: false, consecutiveEmptyWakes: 0 })).toBe(false);
  });
});
