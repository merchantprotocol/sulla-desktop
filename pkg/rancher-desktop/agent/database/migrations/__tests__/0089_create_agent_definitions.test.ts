import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0089_create_agent_definitions';

describe('0089 create agent definitions migration', () => {
  it('stores the runtime definition fields and marketplace lifecycle state', () => {
    expect(up).toContain('CREATE TABLE IF NOT EXISTS agent_definitions');
    expect(up).toContain('system_prompt');
    expect(up).toContain('soul_content');
    expect(up).toContain('allowed_tools         TEXT[]');
    expect(up).toContain('skill_refs            TEXT[]');
    expect(up).toContain('routine_refs          TEXT[]');
    expect(up).toContain('model_priority        JSONB');
    expect(up).toContain("CHECK (status IN ('draft', 'production', 'archive'))");
    expect(up).toContain('jsonb_typeof(model_priority) = \'array\'');
  });

  it('is reversible and does not seed agent data', () => {
    expect(up).not.toContain('INSERT INTO');
    expect(down).toContain('DROP TABLE IF EXISTS agent_definitions');
  });
});
