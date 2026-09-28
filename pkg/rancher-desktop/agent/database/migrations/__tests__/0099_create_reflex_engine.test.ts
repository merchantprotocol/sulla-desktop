import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0099_create_reflex_engine';

describe('0099_create_reflex_engine', () => {
  it('creates examples with active-row dedup and decision receipts', () => {
    expect(up).toContain('CREATE TABLE IF NOT EXISTS reflex_examples');
    expect(up).toContain('CREATE UNIQUE INDEX IF NOT EXISTS reflex_examples_active_unique');
    expect(up).toContain('(lower(utterance), tool_name, md5(params::text), positive)');
    expect(up).toContain('WHERE NOT archived');
    expect(up).toContain('CREATE TABLE IF NOT EXISTS reflex_decisions');
    expect(down).toContain('DROP TABLE IF EXISTS reflex_examples');
    expect(down).toContain('DROP TABLE IF EXISTS reflex_decisions');
  });
});
