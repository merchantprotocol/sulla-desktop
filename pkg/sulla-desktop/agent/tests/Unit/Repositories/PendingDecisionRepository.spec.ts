// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
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

  it('loads a child-thread approval from the root transcript using persisted ancestry', async() => {
    // risk: authorization — a root-chat card must resolve the decision owned by its exact child, not drop it or title-match another thread.
    const record = {
      id: 'child-approval', conversationId: 'child-thread', relatedConversationIds: ['child-thread', 'root-thread'],
      kind: 'approval', status: 'pending',
    } as any;
    const query = vi.fn(async(sql: string, params: unknown[] = []) =>
      sql.includes("COALESCE(record->'relatedConversationIds'") && params[0] === 'root-thread' && Array.isArray(params[1]) && params[1].includes('child-approval')
        ? [{ record }] : []);
    const repository = new PendingDecisionRepository({ query });

    await expect(repository.listTranscriptDecisions('root-thread', ['child-approval'])).resolves.toEqual([record]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("COALESCE(record->'relatedConversationIds'"), ['root-thread', ['child-approval']]);
  });

  it('expires durable Files approvals and returns the changed decision for subscribers', async() => {
    // risk: irreversible side effects — a publish approval that expires after restart must transition to expired so Files rejects it.
    const expired = { id: 'files-expired', kind: 'approval', status: 'expired', payload: { filesPublishRequestId: 'request-1' } } as any;
    const query = vi.fn(async() => [{ record: expired }]);
    const repository = new PendingDecisionRepository({ query });

    await expect(repository.expireOpenDecisions('new-session', 500)).resolves.toEqual([expired]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("NULLIF(record#>>'{payload,filesPublishRequestId}','') IS NOT NULL");
    expect(sql).toContain('RETURNING record');
    expect(params).toEqual(['new-session', 500]);
  });
});
