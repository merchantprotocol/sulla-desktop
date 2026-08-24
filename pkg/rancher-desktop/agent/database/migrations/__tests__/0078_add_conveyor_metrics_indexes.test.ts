import { describe, expect, it } from '@jest/globals';
import { up, down } from '../0078_add_conveyor_metrics_indexes';

describe('0078_add_conveyor_metrics_indexes', () => {
  it('creates the bounded conveyor-metric indexes additively', () => {
    expect(up).toContain('CREATE INDEX IF NOT EXISTS');
    expect(up).toContain('idx_wtd_kind_finished');
    expect(up).toContain('idx_wtd_verif_generation');
    expect(up).toContain('idx_wtd_task_kind');
    expect(up).toContain('idx_work_tasks_completed');
    expect(up).toContain('idx_work_tasks_activity');
    // additive only: never mutates data or drops schema
    expect(up).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(up).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it('down drops exactly the indexes it created', () => {
    expect(down).toContain('DROP INDEX IF EXISTS idx_wtd_kind_finished');
    expect(down).toContain('DROP INDEX IF EXISTS idx_wtd_verif_generation');
    expect(down).toContain('DROP INDEX IF EXISTS idx_wtd_task_kind');
    expect(down).toContain('DROP INDEX IF EXISTS idx_work_tasks_completed');
    expect(down).toContain('DROP INDEX IF EXISTS idx_work_tasks_activity');
  });
});
