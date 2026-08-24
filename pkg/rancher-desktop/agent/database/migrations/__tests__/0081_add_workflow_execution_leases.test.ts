import { describe, expect, it } from '@jest/globals';
import { down, up } from '../0081_add_workflow_execution_leases';
import { migrationsRegistry } from '..';

describe('0081_add_workflow_execution_leases', () => {
  it('is additive, ordered after 0077, and defines stale-lease recovery fields', () => {
    expect(up).toContain('ADD COLUMN IF NOT EXISTS owner_id');
    expect(up).toContain('lease_expires_at');
    expect(up).toContain('attempt_count INTEGER NOT NULL DEFAULT 0');
    expect(up).toContain('idx_wf_executions_stale_lease');
    expect(up).toContain("status IN ('running', 'suspended')");
    expect(migrationsRegistry.findIndex(m => m.name.startsWith('0081')))
      .toBeGreaterThan(migrationsRegistry.findIndex(m => m.name.startsWith('0077')));
  });

  it('replays safely and is reversible', () => {
    expect(up.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(9);
    expect(up).toContain('CREATE INDEX IF NOT EXISTS');
    expect(down).toContain('DROP INDEX IF EXISTS idx_wf_executions_stale_lease');
    expect(down).toContain('DROP COLUMN IF EXISTS owner_id');
  });
});
