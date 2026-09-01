import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0094_durable_agent_completion_delivery';

describe('0094_durable_agent_completion_delivery', () => {
  it('adds a durable parent target and acknowledgement marker', () => {
    expect(up).toContain('parent_channel TEXT');
    expect(up).toContain('parent_thread_id TEXT');
    expect(up).toContain('completion_delivered_at TIMESTAMPTZ');
    expect(up).toContain("status = 'completed' AND completion_delivered_at IS NULL");
    expect(down).toContain('DROP INDEX IF EXISTS idx_agent_jobs_pending_completion');
  });
});
