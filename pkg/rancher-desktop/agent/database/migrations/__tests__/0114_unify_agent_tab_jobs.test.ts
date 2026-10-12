import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0114_unify_agent_tab_jobs';

describe('0114_unify_agent_tab_jobs', () => {
  it('adds the tab visibility and parent agent to agent_jobs', () => {
    expect(up).toContain("visibility TEXT NOT NULL DEFAULT 'hidden'");
    expect(up).toContain('parent_agent_id TEXT');
    expect(up).toContain('idx_agent_jobs_open_tabs');
  });

  it('backfills open and returned tab contracts as tab jobs keyed by the contract id', () => {
    expect(up).toMatch(/INSERT INTO agent_jobs[\s\S]*SELECT\s+c\.id,/);
    expect(up).toContain("WHERE c.status IN ('open', 'returned')");
    expect(up).toContain("CASE c.status WHEN 'open' THEN 'running' ELSE 'completed' END");
    expect(up).toContain("'visibility', 'tab'");
    expect(up).toContain('ON CONFLICT (job_id) DO NOTHING');
    // Returned rows were already injected into their parent by the old path.
    expect(up).toContain("CASE WHEN c.status = 'returned' THEN COALESCE(c.returned_at, c.created_at) END");
  });

  it('never drops agent_tab_contracts', () => {
    expect(up).not.toMatch(/DROP TABLE/i);
    expect(down).not.toMatch(/DROP TABLE/i);
    expect(down).toContain('DROP COLUMN IF EXISTS visibility');
  });
});
