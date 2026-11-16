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
