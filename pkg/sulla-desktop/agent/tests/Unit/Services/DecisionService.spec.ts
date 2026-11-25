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
import { PublishApprovalCoordinator } from '../../../tools/files/PublishApprovalCoordinator';

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
      settle: vi.fn(async() => true),
      settleDurablePublish: vi.fn(async(_id: string, action: string, next: any, now: number) => {
        if (stored.status !== 'pending' || now >= stored.expiresAt) return false;
        stored = next;
        return action === 'approved';
      }),
    };
    const pendingDecisions = { findById: vi.fn(async(id: string) => id === stored.id ? stored : undefined) };
    const service = new DecisionService(undefined, { decisions: decisions as any, pendingDecisions: pendingDecisions as any });
    const changed: any[] = [];
    service.subscribe(next => changed.push(next));

    await expect(service.resolve({ id: record.id, conversationId: 'child-thread', action: 'approved' })).resolves.toMatchObject({ settled: true });
    // The session-free write is the publish-only one; the general settle keeps its session owner.
    expect(decisions.settleDurablePublish).toHaveBeenCalledWith(record.id, 'approved', expect.objectContaining({ status: 'approved' }), expect.any(Number));
    expect(decisions.settle).not.toHaveBeenCalled();
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
      settleDurablePublish: vi.fn(async(_id: string, action: string, next: any) => { stored = next; return action === 'approved' }),
    };
    const service = new DecisionService(undefined, { decisions: decisions as any, pendingDecisions: pendingDecisions as any });

    const cards = await service.listTranscriptDecisions('root-thread', [record.id]);
    expect(cards).toEqual([record]);
    await expect(service.resolve({ id: cards[0].id, conversationId: cards[0].conversationId, action: 'approved' })).resolves.toMatchObject({ settled: true });
    expect(decisions.settleDurablePublish).toHaveBeenCalledWith(record.id, 'approved', expect.objectContaining({ conversationId: 'child-thread', status: 'approved' }), expect.any(Number));
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

  it('does not announce an expiry when a durable publish approval already settled', async() => {
    // risk: irreversible side effects — a stale container timer must not tell an asker that an approved publish expired.
    let status = 'pending';
    const decisions = {
      insert: vi.fn(async() => undefined),
      expirePending: vi.fn(async() => {
        if (status !== 'pending') return undefined;
        status = 'expired';
        return { id: 'publish-decision', kind: 'approval', status: 'expired', payload: { filesPublishRequestId: 'publish-1' } } as any;
      }),
      settleDurablePublish: vi.fn(async() => { status = 'approved'; return true; }),
    };
    const service = new DecisionService(undefined, { decisions: decisions as any, pendingDecisions: { ancestry: vi.fn(async() => []) } as any });
    const deliver = vi.fn(async() => true);
    const coordinator = new PublishApprovalCoordinator(service, { deliver }, { for: async() => 'Publish approved.' });
    coordinator.start();
    const { record } = await service.request({
      kind: 'approval', title: 'Publish?', toolName: 'files_request_publish', conversationId: 'thread-1', channel: 'channel-1',
      payload: { filesPublishRequestId: 'publish-1' },
    } as any, 60_000);
    const changed: any[] = [];
    service.subscribe(record => changed.push(record));

    await decisions.settleDurablePublish();
    await service.expire(record.id);

    expect(changed).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('announces a normal pending-decision expiry exactly once', async() => {
    // risk: irreversible side effects — a genuinely expired publish must reach Files and its asker exactly once.
    const expired = { id: 'publish-decision', kind: 'approval', status: 'expired', payload: { filesPublishRequestId: 'publish-1' } } as any;
    const decisions = {
      insert: vi.fn(async() => undefined),
      expirePending: vi.fn(async() => expired),
    };
    const service = new DecisionService(undefined, { decisions: decisions as any, pendingDecisions: { ancestry: vi.fn(async() => []) } as any });
    const deliver = vi.fn(async() => true);
    const coordinator = new PublishApprovalCoordinator(service, { deliver }, { for: async() => 'Publish expired.' });
    coordinator.start();
    const { record } = await service.request({
      kind: 'approval', title: 'Publish?', toolName: 'files_request_publish', conversationId: 'thread-1', channel: 'channel-1',
      payload: { filesPublishRequestId: 'publish-1' },
    } as any, 60_000);
    const changed: any[] = [];
    service.subscribe(next => changed.push(next));

    await service.expire(record.id);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

    expect(changed).toEqual([expired]);
    expect(deliver).toHaveBeenCalledWith(expired, 'Publish expired.');
    coordinator.dispose();
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
