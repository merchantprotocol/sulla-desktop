// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PostgresConnection } from '@sulla/foundation/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AgentJobMessagingRepository } from '../../../app/Repositories/AgentJobMessagingRepository';
import { AgentJobRepository } from '../../../app/Repositories/AgentJobRepository';
import { TestDatabase } from '../../Support/TestDatabase';

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('AgentJobMessagingRepository', () => {
  const database = new TestDatabase();
  let jobs: AgentJobRepository;
  let messages: AgentJobMessagingRepository;

  beforeAll(async() => {
    await database.initialize();
    const connection = new PostgresConnection({ query: async(sql, bindings) => {
      const rows = await database.query(sql, [...(bindings ?? [])]);
      return { rows, rowCount: rows.length };
    } });
    jobs = new AgentJobRepository(connection);
    messages = new AgentJobMessagingRepository(connection);
  }, 60_000);
  afterAll(async() => database.dispose());

  it('round-trips messages and makes delivery acknowledgement idempotent', async() => {
    // risk: duplicate delivery of parent-to-worker instructions
    await jobs.insertJob({ jobId: 'message-idempotency', status: 'running', createdAt: Date.now(),
      finishedAt: null, taskCount: 1, results: [], visibility: 'hidden',
      tasks: [{ agentId: 'worker', label: 'lane', prompt: 'work', status: 'running', threadId: 'message-thread' }] });
    const target = (await messages.targetsForJob('message-idempotency'))[0];
    const queued = await messages.queueMessage(target, 'continue');
    expect((await messages.pendingMessagesForThread('message-thread')).map(item => item.message)).toEqual(['continue']);
    await messages.markMessagesDelivered([queued.id], 'message-thread');
    await database.query("UPDATE agent_job_messages SET delivered_at = TIMESTAMP '2000-01-01 00:00:00' WHERE id = $1", [queued.id]);
    const [{ delivered_at: firstDelivery }] = await database.query<{ delivered_at: Date }>('SELECT delivered_at FROM agent_job_messages WHERE id = $1', [queued.id]);
    await messages.markMessagesDelivered([queued.id], 'message-thread');
    expect(await messages.pendingMessagesForThread('message-thread')).toEqual([]);
    const [{ delivered_at: secondDelivery }] = await database.query<{ delivered_at: Date }>('SELECT delivered_at FROM agent_job_messages WHERE id = $1', [queued.id]);
    expect(secondDelivery.getTime()).toBe(firstDelivery.getTime());
  });
});
