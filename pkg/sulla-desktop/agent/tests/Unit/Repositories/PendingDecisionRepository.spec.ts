// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { PendingDecisionRepository } from '../../../repositories/PendingDecisionRepository';

describe('PendingDecisionRepository', () => {
  it('reuses the pending Decide approval for a Files publish request', async() => {
    // risk: irreversible side effects — retrying publication must not create duplicate human approvals.
    const record = { id:'decision-1', kind:'approval', status:'pending' } as any;
    const calls: unknown[][] = [];
    const repository = new PendingDecisionRepository({ query: async(_sql, params = []) => { calls.push(params); return [{ record }] } });
    await expect(repository.findApproval('session-1', 'filesPublishRequestId', 'request-1', 123)).resolves.toBe(record);
    expect(calls).toEqual([['session-1', 'filesPublishRequestId', 'request-1', 123]]);
  });
});
