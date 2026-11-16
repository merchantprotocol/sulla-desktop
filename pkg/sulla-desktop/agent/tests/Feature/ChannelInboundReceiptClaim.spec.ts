// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TestDatabase } from '../Support/TestDatabase';
import { PostgresConversationBindingRepository } from '../../app/Repositories/PostgresConversationBindingRepository';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

class TestDatabaseClient {
  constructor(private readonly database: TestDatabase) {}
  async queryOne<T>(sql: string, values: unknown[] = []): Promise<T | null> {
    return (await this.database.query<T & Record<string, unknown>>(sql, values))[0] ?? null;
  }
}

dbDescribe('channel inbound receipt claims', () => {
  const database = new TestDatabase();
  let repository: PostgresConversationBindingRepository;

  beforeAll(async() => {
    await database.initialize();
    repository = new PostgresConversationBindingRepository(new TestDatabaseClient(database) as never);
  });
  afterAll(async() => database.dispose());

  it('reclaims only stale processing receipts and leaves completed or recent receipts claimed', async() => {
    // risk: data loss — a worker crash after claiming must not permanently suppress provider retries.
    await database.query(`INSERT INTO inbound_receipts(channel_type,event_id,status,created_at) VALUES
      ('slack','stale','processing',NOW()-INTERVAL '6 minutes'),
      ('slack','recent','processing',NOW()-INTERVAL '4 minutes'),
      ('slack','done','complete',NOW()-INTERVAL '6 minutes')`);

    expect(await repository.claimReceipt('slack', 'stale')).toBe(true);
    expect(await repository.claimReceipt('slack', 'recent')).toBe(false);
    expect(await repository.claimReceipt('slack', 'done')).toBe(false);
    expect(await database.query<{ event_id: string; status: string }>(`SELECT event_id,status FROM inbound_receipts WHERE event_id IN ('stale','recent','done') ORDER BY event_id`))
      .toEqual([{ event_id: 'done', status: 'complete' }, { event_id: 'recent', status: 'processing' }, { event_id: 'stale', status: 'processing' }]);
    await database.query(`DELETE FROM inbound_receipts WHERE event_id IN ('stale','recent','done')`);
  });
});
