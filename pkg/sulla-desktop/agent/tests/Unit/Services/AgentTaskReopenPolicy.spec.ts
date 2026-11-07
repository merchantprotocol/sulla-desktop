// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { AgentTaskReopenPolicy } from '../../../app/ValueObjects/AgentTaskReopenPolicy';
describe('AgentTaskReopenPolicy', () => {
  const policy = new AgentTaskReopenPolicy();
  it('allows completed and blocked tasks below the limit', () => {
    // risk: managers cannot continue a successfully returned or explicitly blocked worker
    expect(policy.decide('completed', 0, false)).toEqual({ allowed: true });
    expect(policy.decide('blocked', 4, false)).toEqual({ allowed: true });
  });
  it.each([['stopped', 0, false, 'stopped'], ['error', 0, false, 'failed'], ['running', 0, false, 'not_finished'], ['completed', 5, false, 'limit_reached'], ['completed', 0, true, 'active_lease']] as const)
    ('refuses %s with a typed reason', (status, count, lease, reason) => {
      // risk: duplicate or unsafe task replay
      expect(policy.decide(status, count, lease)).toEqual({ allowed: false, reason });
    });
});
