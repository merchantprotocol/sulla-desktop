// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { DelegatedTurnSettlementPolicy, MissingContractAfterReminderError, TurnEndClassifier } from '../../../services/DelegatedTurnSettlementPolicy';
import { extractAgentTurnOutcome } from '../../../tools/agents/agentTurnOutcome';
describe('DelegatedTurnSettlementPolicy', () => {
  const policy = new DelegatedTurnSettlementPolicy();
  it('does not complete explicit continue markers and auto-parks, capped at three', () => {
    // risk: a worker ending with unfinished work wakes its parent as completed
    const input = { returned: false, openChildren: 0, pendingWait: false, reminderSent: true, finalText: '<AGENT_CONTINUE> still working', schemaContract: false };
    expect(policy.decide(input)).toBe('auto_park');
    expect(policy.decide({ ...input, autoParkCount: 2 })).toBe('auto_park');
    expect(policy.decide({ ...input, autoParkCount: 3 })).toBe('fail');
  });
  it('completes explicit done text and never penalizes pending waits', () => {
    // risk: explicit completion or a legitimate wait is misclassified as abandoned work
    expect(new TurnEndClassifier().classify('<AGENT_DONE> result')).toBe('completed');
    expect(extractAgentTurnOutcome({ messages: [{ role: 'assistant', content: '<AGENT_DONE> result' }] }).status).toBe('completed');
    expect(extractAgentTurnOutcome({ messages: [{ role: 'assistant', content: '<AGENT_BLOCKED> need input' }] }).status).toBe('blocked');
    expect(policy.decide({ returned: false, openChildren: 0, pendingWait: true, reminderSent: true, finalText: '<AGENT_CONTINUE>', autoParkCount: 3 })).toBe('wait_park');
  });
  it('preserves schema contract reminder-then-fail for unmarked missing returns', () => {
    // risk: schema-constrained workers stop receiving the contract enforcement path
    const input = { returned: false, openChildren: 0, pendingWait: false, schemaContract: true, finalText: 'work update' };
    expect(policy.decide({ ...input, reminderSent: false })).toBe('remind');
    expect(policy.decide({ ...input, reminderSent: true })).toBe('fail');
  });
  it('parks each repeated wait and reaches terminal only after the worker returns', () => {
    // risk: a second long wait is mistaken for a missing contract and kills a healthy worker
    const turns = [
      { returned: false, openChildren: 0, pendingWait: true, reminderSent: false },
      { returned: false, openChildren: 0, pendingWait: true, reminderSent: false },
      { returned: true, openChildren: 0, pendingWait: false, reminderSent: false },
    ];
    expect(turns.map(turn => policy.decide(turn))).toEqual(['wait_park', 'wait_park', 'terminal']);
  });
  it('preserves F-1 child parking ahead of explicit waits and reminders', () => {
    // risk: the worker wait story regresses existing manager/child lifecycle behavior
    expect(policy.decide({ returned: false, openChildren: 2, pendingWait: true, reminderSent: false })).toBe('child_park');
  });
  it('parks a wait scheduled during the reminder turn instead of failing', () => {
    // risk: reminderSent is incorrectly treated as terminal while the worker is legitimately parked
    expect(policy.decide({ returned: false, openChildren: 0, pendingWait: false, reminderSent: false })).toBe('remind');
    expect(policy.decide({ returned: false, openChildren: 0, pendingWait: true, reminderSent: true })).toBe('wait_park');
    expect(policy.decide({ returned: true, openChildren: 0, pendingWait: false, reminderSent: true })).toBe('terminal');
  });
  it('skips injected assistant context and bounds the last real assistant cause', () => {
    // risk: private recalled context is exposed as a fabricated worker failure.
    const cause = policy.failureCause({ messages: [
      { role: 'assistant', content: `real worker output ${ 'x'.repeat(3_000) }` },
      { role: 'user', content: 'contract reminder' },
      { role: 'assistant', content: '<observational_memory>private recalled context</observational_memory>' },
    ] });
    expect(cause).toContain('real worker output');
    expect(cause).not.toContain('private recalled context');
    expect(cause).toHaveLength(2_000);
  });
  it('reminds exactly once, then reports a typed failure carrying the real last output', () => {
    // risk: agent death is misreported as fabricated provider failure
    expect(policy.decide({ returned: false, openChildren: 0, pendingWait: false, reminderSent: false })).toBe('remind');
    expect(policy.decide({ returned: false, openChildren: 0, pendingWait: false, reminderSent: true })).toBe('fail');
    const cause = policy.failureCause({ messages: [{ role: 'assistant', content: 'real last text' }, { role: 'user', content: 'reminder' }] });
    const error = new MissingContractAfterReminderError(cause);
    expect(error.code).toBe('missing_contract_after_reminder');
    expect(error.message).toContain('real last text');
    expect(error.message).not.toContain('provider failure');
  });
});
