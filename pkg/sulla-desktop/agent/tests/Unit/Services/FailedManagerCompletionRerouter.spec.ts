// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentCompletionInboxService } from '../../../app/Services/AgentCompletionInboxService';
import { CompletionFormatter } from '../../../app/Services/CompletionFormatter';
import { CompletionIdleDispatcher } from '../../../app/Services/CompletionIdleDispatcher';
import { FailedManagerCompletionRerouter } from '../../../services/FailedManagerCompletionRerouter';

describe('FailedManagerCompletionRerouter', () => {
  it('delivers an unconsumed child completion to the grandparent exactly once', async() => {
    // risk: settled delegated results are lost when a manager exhausts empty-wake retries
    const inbox = new AgentCompletionInboxService(new CompletionIdleDispatcher(), new CompletionFormatter(10_000));
    const rerouter = new FailedManagerCompletionRerouter(inbox);
    const manager = { jobId: 'manager', parentThreadId: 'grandparent', parentChannel: 'sulla-desktop' } as any;
    const completion = { jobId: 'child', taskIndex: 2, results: [{ label: 'child', status: 'completed', output: 'done' }] } as any;

    await rerouter.route(manager, 0, 'empty wake cap reached', [completion]);
    await rerouter.route(manager, 0, 'empty wake cap reached', [completion]);

    const delivered = inbox.take('sulla-desktop', 'grandparent');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].results[0].output).toContain('orphaned from failed manager manager#0: empty wake cap reached');
    expect(delivered[0].results[0].output).toContain('done');
  });
});
