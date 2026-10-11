import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0110_add_agent_directory_fields';

describe('0110 add agent directory fields migration', () => {
  it('adds directory card and built-in tracking columns with safe defaults', () => {
    for (const column of ['when_to_call', 'when_not_to_call', 'send', 'returns', 'cost_tier', 'can_call', 'is_builtin', 'builtin_hash']) {
      expect(up).toContain(`ADD COLUMN IF NOT EXISTS ${ column }`);
    }
    expect(up).toContain("cost_tier IN ('low', 'medium', 'high')");
    expect(up).toContain('CREATE TABLE IF NOT EXISTS agent_builtin_seed_ledger');
  });

  it('is additive: no drops, updates or seeded rows on the way up', () => {
    expect(up).not.toMatch(/\bDROP\b|\bUPDATE\b|\bDELETE\b|INSERT INTO/);
    expect(down).toContain('DROP TABLE IF EXISTS agent_builtin_seed_ledger');
    expect(down).toContain('DROP COLUMN IF EXISTS when_to_call');
  });
});
