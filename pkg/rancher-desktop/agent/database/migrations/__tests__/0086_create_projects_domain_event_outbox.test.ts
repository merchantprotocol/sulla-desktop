import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0086_create_projects_domain_event_outbox';

describe('0086 Projects domain-event outbox migration', () => {
  it('creates a generation-scoped idempotent lease outbox', () => {
    expect(up).toContain('CREATE TABLE IF NOT EXISTS work_project_domain_events');
    expect(up).toContain('idempotency_key TEXT NOT NULL UNIQUE');
    expect(up).toContain('generation INTEGER NOT NULL');
    expect(up).toContain("status IN ('pending', 'processing', 'completed')");
    expect(up).toContain('work_project_domain_events_lease_pair');
    expect(up).toContain('idx_work_project_domain_events_expired');
  });

  it('remains additive on upgrade and reversible in isolation', () => {
    expect(up).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
    expect(down).toContain('DROP TABLE IF EXISTS work_project_domain_events');
  });
});
