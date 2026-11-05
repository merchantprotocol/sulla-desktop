// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { DelegatedTurnSettlementPolicy, MissingContractAfterReminderError } from '../../../services/DelegatedTurnSettlementPolicy';
describe('DelegatedTurnSettlementPolicy', () => {
  const policy = new DelegatedTurnSettlementPolicy();
  it('parks waits and child dependencies before reminder settlement', () => {
    // risk: legitimate long-running work fails, or #2008 child parking regresses
    expect(policy.decide({ returned: false, openChildren: 0, pendingWait: true, reminderSent: false })).toBe('wait_park');
    expect(policy.decide({ returned: false, openChildren: 2, pendingWait: false, reminderSent: false })).toBe('child_park');
  });
  it('reminds once, then reports a typed failure carrying the real output', () => {
    // risk: agent death is misreported as fabricated provider failure
    expect(policy.decide({ returned: false, openChildren: 0, pendingWait: false, reminderSent: false })).toBe('remind');
    expect(policy.decide({ returned: false, openChildren: 0, pendingWait: false, reminderSent: true })).toBe('fail');
    const error = new MissingContractAfterReminderError('assistant stopped after reminder');
    expect(error.code).toBe('missing_contract_after_reminder'); expect(error.message).toContain('assistant stopped'); expect(error.message).not.toContain('provider failure');
    expect(policy.failureCause({ messages: [{ role: 'assistant', content: 'real last text' }, { role: 'user', content: 'reminder' }] })).toBe('real last text');
  });
});
