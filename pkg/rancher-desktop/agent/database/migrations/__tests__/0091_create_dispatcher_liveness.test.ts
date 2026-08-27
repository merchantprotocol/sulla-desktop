import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0091_create_dispatcher_liveness';

describe('0091_create_dispatcher_liveness', () => {
  it('creates one durable dispatcher heartbeat row independent of work items', () => {
    expect(up).toContain('CREATE TABLE IF NOT EXISTS dispatcher_liveness');
    expect(up).toContain('last_tick_started_at');
    expect(up).toContain('next_expected_tick_at');
    expect(up).toContain('consecutive_wedge_count');
    expect(up).toContain('ON CONFLICT (id) DO NOTHING');
    expect(down).toContain('DROP TABLE IF EXISTS dispatcher_liveness');
  });
});
