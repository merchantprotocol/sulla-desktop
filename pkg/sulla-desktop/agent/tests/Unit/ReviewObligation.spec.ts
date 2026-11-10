// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { ReviewItemClosureValidator } from '../../app/Services/ReviewItemClosureValidator';
import { ReviewObligationGate } from '../../app/Services/ReviewObligationGate';

describe('tracked review-item obligations', () => {
  const validator = new ReviewItemClosureValidator();

  it('requires a commit for fixed and a reason for wont_fix', () => {
    // risk: review findings could be falsely reported fixed without a verifiable change
    expect(validator.validate([{ id: 'R1', status: 'fixed' }], ['R1'])).toContain('commit sha');
    expect(validator.validate([{ id: 'R1', status: 'wont_fix' }], ['R1'])).toContain('non-empty reason');
    expect(validator.validate([{ id: 'R1', status: 'fixed', commit: 'a8e8d13' }], ['R1'])).toBeNull();
    expect(validator.validate([{ id: 'R1', status: 'wont_fix', reason: 'not applicable' }], ['R1'])).toBeNull();
  });

  it('rejects unknown ids and reports the valid open ids', () => {
    // risk: a worker could appear to close an item belonging to a different task
    expect(validator.validate([{ id: 'R9', status: 'acknowledged' }], ['R1', 'R2'])).toContain('R1, R2');
  });

  it('blocks open and acknowledged items, then allows a fully closed task', async() => {
    // risk: a worker could return despite unapplied review findings
    let items = [
      { id: 'R1', text: 'Fix missing null guard', status: 'open' as const },
      { id: 'R2', text: 'Preserve tenant filter', status: 'acknowledged' as const },
    ];
    const gate = new ReviewObligationGate({ itemsForTask: async() => items } as any);
    expect(await gate.refusal('job-a', 0)).toContain('R1: Fix missing null guard');
    expect(await gate.refusal('job-a', 0)).toContain('R2: Preserve tenant filter');
    items = [];
    expect(await gate.refusal('job-a', 0)).toBeNull();
  });
});
