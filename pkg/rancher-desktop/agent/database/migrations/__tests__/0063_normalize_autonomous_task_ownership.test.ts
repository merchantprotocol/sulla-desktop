import { describe, expect, it } from '@jest/globals';

import {
  down,
  OWNERSHIP_MIGRATION_COMMENT_PREFIX,
  up,
} from '../0063_normalize_autonomous_task_ownership';

describe('0063_normalize_autonomous_task_ownership', () => {
  it('backfills only open autonomous legacy todos and writes one audit marker per task', () => {
    expect(up).toContain(`status = 'todo'`);
    expect(up).toContain(`LOWER(COALESCE(assignee, '')) = 'sulla'`);
    expect(up).toContain(`WHERE LOWER(label) = ANY(ARRAY['gated', 'decision', 'human', 'manual', 'no-auto-dispatch']::text[])`);
    expect(up).toContain(`SET assignee = 'dispatcher'`);
    expect(up).toContain(`SELECT '${ OWNERSHIP_MIGRATION_COMMENT_PREFIX }' || id`);
    expect(up).toContain('ON CONFLICT (id) DO NOTHING');
  });

  it('has a targeted rollback using only migration-marked tasks', () => {
    expect(down).toContain(`c.id = '${ OWNERSHIP_MIGRATION_COMMENT_PREFIX }' || t.id`);
    expect(down).toContain(`SET assignee = 'sulla'`);
    expect(down).toContain(`LOWER(COALESCE(t.assignee, '')) = 'dispatcher'`);
    expect(down).toContain(`SET archived = true`);
  });
});
