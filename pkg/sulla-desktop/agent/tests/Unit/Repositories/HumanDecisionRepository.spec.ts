// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { HumanDecisionRepository } from '../../../app/Repositories/HumanDecisionRepository';
import { ToolApprovalPolicyRepository } from '../../../app/Repositories/ToolApprovalPolicyRepository';

import type { DecisionRecord } from '@pkg/shared/decisions';

class FakeQueryClient {
  readonly calls: { sql: string; params?: unknown[] }[] = [];
  constructor(private readonly rows: unknown[] = []) {}
  query = vi.fn(async(sql: string, params?: unknown[]) => { this.calls.push({ sql, params }); return this.rows as any[] });
}

const record = { id: 'd-1', kind: 'approval', status: 'pending', conversationId: 't-1', channel: 'c', title: 'x', createdAt: 1, expiresAt: 2 } as unknown as DecisionRecord;

describe('HumanDecisionRepository', () => {
  // risk: irreversible side effects — a decision is only settled when it is still pending AND owned by this process session.
  it('settles only pending rows owned by the session and reports whether a row changed', async() => {
    const changed = new FakeQueryClient([{ id: 'd-1' }]);
    const next = { ...record, status: 'approved' } as DecisionRecord;
    await expect(new HumanDecisionRepository(changed).settle('d-1', 'approved', next, 'session-a')).resolves.toBe(true);
    expect(changed.calls[0].sql).toMatch(/WHERE id = \$1 AND status IN \('pending', 'deferred'\) AND session_id = \$4 RETURNING id/);
    expect(changed.calls[0].params).toEqual(['d-1', 'approved', JSON.stringify(next), 'session-a']);

    await expect(new HumanDecisionRepository(new FakeQueryClient([])).settle('d-1', 'approved', next, 'session-a')).resolves.toBe(false);
  });

  // risk: irreversible side effects — the only session-free settle is limited to an unexpired Files publish approval in its own conversation.
  it('settles a durable publish approval without a session only while it is an unexpired publish approval', async() => {
    const changed = new FakeQueryClient([{ id: 'd-1' }]);
    const next = { ...record, status: 'approved' } as DecisionRecord;
    await expect(new HumanDecisionRepository(changed).settleDurablePublish('d-1', 'approved', next, 1234)).resolves.toBe(true);
    const sql = changed.calls[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain("WHERE id = $1 AND status IN ('pending', 'deferred') AND record->>'kind' = 'approval'");
    expect(sql).toContain("AND NULLIF(record#>>'{payload,filesPublishRequestId}', '') IS NOT NULL");
    expect(sql).toContain("AND (record->>'expiresAt')::bigint > $4 AND record->>'conversationId' = $5 RETURNING id");
    expect(sql).not.toContain('session_id');
    expect(changed.calls[0].params).toEqual(['d-1', 'approved', JSON.stringify(next), 1234, 't-1']);

    await expect(new HumanDecisionRepository(new FakeQueryClient([])).settleDurablePublish('d-1', 'approved', next, 1234)).resolves.toBe(false);
  });

  // risk: data accuracy — the inserted row carries the session and the full record JSON.
  it('inserts the record under the current session', async() => {
    const client = new FakeQueryClient();
    await new HumanDecisionRepository(client).insert(record, 'session-a');
    expect(client.calls[0].params).toEqual(['d-1', 'session-a', 'pending', JSON.stringify(record)]);
  });

  // risk: fail closed — rows from another process or past their deadline are expired before listing.
  it('expires foreign or overdue rows and returns the stored records', async() => {
    const client = new FakeQueryClient([{ record }]);
    const repo = new HumanDecisionRepository(client);
    await repo.expireForeignOrOverdue('session-a', 1234);
    expect(client.calls[0].sql).toMatch(/session_id <> \$1 OR \(record->>'expiresAt'\)::bigint <= \$2/);
    expect(client.calls[0].params).toEqual(['session-a', 1234]);
    await expect(repo.listRecent()).resolves.toEqual([record]);
  });

  it('expires a single pending decision by id', async() => {
    const client = new FakeQueryClient();
    await new HumanDecisionRepository(client).expirePending('d-9');
    expect(client.calls[0].sql).toMatch(/SET status = 'expired'/);
    expect(client.calls[0].params).toEqual(['d-9']);
  });
});

describe('ToolApprovalPolicyRepository', () => {
  // risk: permissions — a tool requires approval exactly when a policy row exists.
  it('reports approval required only when a policy row exists', async() => {
    await expect(new ToolApprovalPolicyRepository(new FakeQueryClient([{ tool_name: 'exec' }])).exists('exec')).resolves.toBe(true);
    await expect(new ToolApprovalPolicyRepository(new FakeQueryClient([])).exists('exec')).resolves.toBe(false);
  });

  it('adds idempotently, removes, and lists tool names', async() => {
    const client = new FakeQueryClient([{ tool_name: 'a' }, { tool_name: 'b' }]);
    const repo = new ToolApprovalPolicyRepository(client);
    await repo.add('exec');
    await repo.remove('exec');
    expect(client.calls[0].sql).toMatch(/ON CONFLICT DO NOTHING/);
    expect(client.calls[1].sql).toMatch(/^DELETE FROM tool_approval_policies WHERE tool_name = \$1/);
    await expect(repo.listToolNames()).resolves.toEqual(['a', 'b']);
  });
});
