import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0090_create_work_task_outcome_journal';

describe('0090 create work task outcome journal migration', () => {
  it('creates an append-only per-dispatch outbox with a pending index', () => {
    expect(up).toContain('work_task_outcome_journal');
    expect(up).toContain('UNIQUE (dispatch_id)');
    expect(up).toContain('consumed_at');
    expect(up).toContain('idx_work_task_outcome_journal_pending');
  });

  it('is reversible', () => {
    expect(down).toContain('DROP TABLE IF EXISTS work_task_outcome_journal');
  });
});
