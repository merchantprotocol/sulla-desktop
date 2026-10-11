import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0111_add_agent_routing';

describe('0111 add agent routing migration', () => {
  it('adds a nullable front_door flag and the delegation log', () => {
    expect(up).toContain('ADD COLUMN IF NOT EXISTS front_door BOOLEAN;');
    expect(up).toContain('CREATE TABLE IF NOT EXISTS agent_delegations');
    expect(up).toContain("outcome IN ('completed', 'failed', 'rejected')");
  });

  it('is additive: no drops, updates or seeded rows on the way up', () => {
    expect(up).not.toMatch(/\bDROP\b|\bUPDATE\b|\bDELETE\b|INSERT INTO/);
    expect(down).toContain('DROP TABLE IF EXISTS agent_delegations');
    expect(down).toContain('DROP COLUMN IF EXISTS front_door');
  });
});
