// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

const busFactory = vi.hoisted(() => vi.fn(() => ({ send: vi.fn() })));
vi.mock('../../../services/WebSocketClientService', () => ({ getWebSocketClientService: busFactory }));
const db = vi.hoisted(() => ({ query: vi.fn((sql: string, _params?: unknown[]) => Promise.resolve(sql.includes('RETURNING id') ? [{ id: 'x' }] : [])) }));
vi.mock('../../../database/PostgresClient', () => ({ postgresClient: db }));

import { DecisionService } from '../../../services/DecisionService';

describe('DecisionService', () => {
  it('constructs without touching the renderer WebSocket client', () => {
    // risk: availability — decision handling must not depend on the renderer; constructing it outside the renderer must not crash or load the bus.
    expect(() => new DecisionService()).not.toThrow();
    expect(busFactory).not.toHaveBeenCalled();
  });

  it('resolves an approval from its persisted record after restart without a waiter', async() => {
    // risk: irreversible side effects — Decide and the inline card must still settle the publish gate after the app process restarts.
    const record = {
      id: 'approval-after-restart', conversationId: 'child-thread', channel: 'chat-channel',
      kind: 'approval', status: 'pending', attention: 'active', createdAt: Date.now(), expiresAt: Date.now() + 7 * 24 * 60 * 60_000,
      payload: { filesPublishRequestId: 'publish-7' },
    } as any;
    let stored = record;
    const decisions = {
      settle: vi.fn(async(_id: string, action: string, next: any, sessionId?: string) => {
        if (stored.status !== 'pending' || sessionId !== undefined) return false;
        stored = next;
        return action === 'approved';
      }),
    };
    const pendingDecisions = { findById: vi.fn(async(id: string) => id === stored.id ? stored : undefined) };
    const service = new DecisionService(undefined, { decisions: decisions as any, pendingDecisions: pendingDecisions as any });
    const changed: any[] = [];
    service.subscribe(next => changed.push(next));

    await expect(service.resolve({ id: record.id, conversationId: 'child-thread', action: 'approved' })).resolves.toMatchObject({ settled: true });
    expect(decisions.settle).toHaveBeenCalledWith(record.id, 'approved', expect.objectContaining({ status: 'approved' }));
    expect(stored.status).toBe('approved');
    expect(changed).toEqual([expect.objectContaining({ id: record.id, status: 'approved' })]);
  });

  it('loads a child approval into the root transcript and resolves the child record using its stored owner', async() => {
    // risk: authorization — a root-chat card must settle the exact persisted child decision without changing its conversation owner.
    const record = {
      id: 'child-approval', conversationId: 'child-thread', relatedConversationIds: ['child-thread', 'root-thread'],
      channel: 'child-channel', kind: 'approval', status: 'pending', createdAt: 100,
      expiresAt: Date.now() + 60_000, payload: { filesPublishRequestId: 'files-request' },
    } as any;
    let stored = record;
    const query = vi.fn(async(sql: string, params: unknown[] = []) =>
      sql.includes("COALESCE(record->'relatedConversationIds'") && params[0] === 'root-thread' && Array.isArray(params[1]) && params[1].includes(record.id)
        ? [{ record }] : []);
    const pendingRepository = new (await import('../../../repositories/PendingDecisionRepository')).PendingDecisionRepository({ query });
    const pendingDecisions = {
      findById: async(id: string) => id === stored.id ? stored : undefined,
      listTranscriptDecisions: (...args: [string, string[]]) => pendingRepository.listTranscriptDecisions(...args),
    };
    const decisions = {
      settle: vi.fn(async(_id: string, action: string, next: any) => { stored = next; return action === 'approved' }),
    };
    const service = new DecisionService(undefined, { decisions: decisions as any, pendingDecisions: pendingDecisions as any });

    const cards = await service.listTranscriptDecisions('root-thread', [record.id]);
    expect(cards).toEqual([record]);
    await expect(service.resolve({ id: cards[0].id, conversationId: cards[0].conversationId, action: 'approved' })).resolves.toMatchObject({ settled: true });
    expect(decisions.settle).toHaveBeenCalledWith(record.id, 'approved', expect.objectContaining({ conversationId: 'child-thread', status: 'approved' }));
    expect(stored.status).toBe('approved');
  });

  it('emits expired persisted publish decisions during reconciliation', async() => {
    // risk: irreversible side effects — expiry discovered after restart must reach Files and the inline card as an event.
    const expired = { id: 'expired-publish', conversationId: 'child-thread', kind: 'approval', status: 'expired', payload: { filesPublishRequestId: 'request-1' } } as any;
    const pendingDecisions = { expireOpenDecisions: vi.fn(async() => [expired]) };
    const decisions = { listRecent: vi.fn(async() => [expired]) };
    const service = new DecisionService(undefined, { decisions: decisions as any, pendingDecisions: pendingDecisions as any });
    const changed: any[] = [];
    service.subscribe(record => changed.push(record));

    await expect(service.list()).resolves.toEqual([expired]);
    expect(pendingDecisions.expireOpenDecisions).toHaveBeenCalledWith(expect.any(String), expect.any(Number));
    expect(changed).toEqual([expired]);
  });
});

describe('a question whose asker stops waiting', () => {
  const question = {
    kind: 'question' as const, title: 'Color?', conversationId: 'thread-1', channel: 'sulla-desktop',
    questions: [{ question: 'Color?', options: [{ label: 'Blue' }] }],
  };

  // risk: user communication. Claude Code drops a silent tool call after 300 s; the
  // question stayed open, so a later answer settled a wait nobody read and was lost.
  it('expires when the waiting call is aborted, so a later answer is not swallowed', async() => {
    db.query.mockClear();
    const service = new DecisionService();
    const caller = new AbortController();
    const { record, result } = await service.request(question, 30 * 60_000, caller.signal);

    caller.abort();

    await expect(result).resolves.toMatchObject({ status: 'expired' });
    expect(db.query.mock.calls.some(([sql, params]) => /SET status = 'expired'/.test(sql) && params?.[0] === record.id)).toBe(true);
  });

  // risk: data loss. Only the status was stored, so answers could not be recovered.
  it('saves the chosen answers with the decision', async() => {
    db.query.mockClear();
    const service = new DecisionService();
    const { record } = await service.request(question, 30 * 60_000);

    await service.resolve({ id: record.id, conversationId: 'thread-1', action: 'answered', answers: [{ question: 'Color?', selected: ['Blue'] }] });

    const update = db.query.mock.calls.find(([sql]) => /UPDATE human_decisions SET status = \$2/.test(sql))!;
    expect(JSON.parse(String(update[1]?.[2])).answers).toEqual([{ question: 'Color?', selected: ['Blue'] }]);
  });
});
