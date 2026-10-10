import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0104_add_agent_job_ui_state';

describe('0104_add_agent_job_ui_state', () => {
  it('adds durable per-task card metadata and dismissal state', () => {
    expect(up).toContain("tasks JSONB NOT NULL DEFAULT '[]'::jsonb");
    expect(up).toContain('dismissed_at TIMESTAMPTZ');
    expect(up).toContain('idx_agent_jobs_parent_thread_visible');
    expect(down).toContain('DROP COLUMN IF EXISTS tasks');
  });
});
