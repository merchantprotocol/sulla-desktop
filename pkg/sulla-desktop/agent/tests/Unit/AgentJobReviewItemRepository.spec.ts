// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentJobReviewItemRepository } from '../../app/Repositories/AgentJobReviewItemRepository';

interface StoredItem { job_id: string; task_index: number; item_id: string; text: string }

/**
 * In-memory stand-in for the review item table. The MAX id is read from a snapshot,
 * then inserts land after a tick, so two concurrent sends read the same MAX and the
 * second one hits the (job_id, task_index, item_id) primary key with SQLSTATE 23505.
 */
class RacingReviewItemTable {
  rows: StoredItem[] = [];
  selectCalls = 0;
  readonly connection = {
    select: async(_sql: string, params: unknown[]) => {
      this.selectCalls++;
      const [jobId, taskIndex, texts] = params as [string, number, string[]];
      const snapshotMax = this.rows.filter(row => row.job_id === jobId && row.task_index === taskIndex)
        .reduce((max, row) => Math.max(max, Number(row.item_id.slice(1))), 0);
      await new Promise(resolve => setImmediate(resolve));
      const inserted = texts.map((text, index) => ({ job_id: jobId, task_index: taskIndex, item_id: `R${ snapshotMax + index + 1 }`, text }));
      for (const row of inserted) {
        if (this.rows.some(existing => existing.job_id === row.job_id && existing.task_index === row.task_index && existing.item_id === row.item_id)) {
          throw Object.assign(new Error('duplicate key value violates unique constraint "agent_job_review_items_pkey"'), { code: '23505' });
        }
      }
      this.rows.push(...inserted);
      return inserted.map(row => ({ item_id: row.item_id }));
    },
    run: async() => undefined,
  };
}

describe('AgentJobReviewItemRepository.createForTask', () => {
  it('gives concurrent sends on one task distinct review ids without losing either batch', async() => {
    // risk: two managers' sends collide on the primary key, dropping an obligation the worker must close
    const table = new RacingReviewItemTable();
    const repository = new AgentJobReviewItemRepository(table.connection as any);

    const [first, second] = await Promise.all([
      repository.createForTask('job-1', 0, ['first fix', 'second fix']),
      repository.createForTask('job-1', 0, ['third fix']),
    ]);

    const allIds = [...first, ...second];
    expect(new Set(allIds).size).toBe(3);
    expect([...allIds].sort()).toEqual(['R1', 'R2', 'R3']);
    expect(table.rows.map(row => row.text).sort()).toEqual(['first fix', 'second fix', 'third fix']);
  });

  it('rethrows errors that are not a unique violation instead of retrying', async() => {
    // risk: a real database failure is retried silently and the send reports success with no items stored
    let calls = 0;
    const repository = new AgentJobReviewItemRepository({
      select: async() => { calls++; throw new Error('connection reset'); },
      run: async() => undefined,
    } as any);

    await expect(repository.createForTask('job-1', 0, ['x'])).rejects.toThrow('connection reset');
    expect(calls).toBe(1);
  });
});
