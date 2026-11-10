// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { OrphanedChildRerouter } from '../../../services/OrphanedChildRerouter';

describe('OrphanedChildRerouter', () => {
  it('keeps the child result and annotates its failed manager context', () => {
    // risk: a valid child contract disappears when its manager dies
    const rerouter = new OrphanedChildRerouter();
    const manager = {
      jobId: 'manager-job', status: 'failed', error: 'wake exhausted', tasks: [{ waitReason: 'empty wake turn; parked with 1 live children' }],
    } as any;
    const results = rerouter.results({
      manager, managerTaskIndex: 0,
      notice: { childJobId: 'child-job', taskIndex: 0, managerThreadId: 'manager-thread', managerStatus: 'failed', results: [], recordedAt: 1 },
    }, [{ label: 'child', status: 'completed', output: 'contract body', threadId: 'child-thread', result: { answer: 42 } }]);

    expect(results[0].output).toContain('orphaned from failed manager manager-job#0: wake exhausted');
    expect(results[0].output).toContain('last check-in: empty wake turn; parked with 1 live children');
    expect(results[0].output).toContain('contract body');
    expect(results[0].result).toEqual({ answer: 42 });
  });
});
