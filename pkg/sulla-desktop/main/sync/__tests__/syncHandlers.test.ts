/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '@pkg/agent/database/PostgresClient';

import { syncHandlers } from '../syncHandlers';

describe('claude conversation sync handler', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('upserts mobile pin and archive timestamps using updated_at conflict ordering', async() => {
    const query = jest.spyOn(postgresClient, 'query').mockResolvedValue([] as any);
    const updatedAt = '2026-10-29T18:00:00.000Z';

    await syncHandlers.claude_conversation.applyRemote({
      dataType: 'claude_conversation',
      entityId: 'conversation-1',
      payload: JSON.stringify({
        id: 'conversation-1',
        contractor_id: 'synthetic-contractor',
        title: 'Renamed',
        pinned: true,
        pinned_at: '2026-10-29T17:55:00.000Z',
        archived: true,
        archived_at: '2026-10-29T17:56:00.000Z',
        unread_count: 3,
        created_at: '2026-10-29T17:00:00.000Z',
        updated_at: updatedAt,
      }),
      updatedAt,
      deleted: false,
    }, 'synthetic-contractor');

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain('pinned_at');
    expect(sql).toContain('archived_at');
    expect(sql).toContain('claude_conversations.contractor_id = $2');
    expect(sql).toContain('AND EXCLUDED.updated_at > claude_conversations.updated_at');
    expect(params[1]).toBe('synthetic-contractor');
    expect(params).toEqual(expect.arrayContaining([
      true,
      '2026-10-29T17:55:00.000Z',
      '2026-10-29T17:56:00.000Z',
      updatedAt,
    ]));
  });
});
