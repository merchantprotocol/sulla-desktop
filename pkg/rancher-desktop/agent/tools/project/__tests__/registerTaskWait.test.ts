import { describe, expect, it } from '@jest/globals';

import { resolveNextCheckAt } from '../register_task_wait';

describe('resolveNextCheckAt', () => {
  it('keeps an explicit monitor schedule unchanged', () => {
    expect(resolveNextCheckAt('human_gate', '2026-08-25T20:00:00.000Z', '2026-12-01T00:00:00.000Z'))
      .toBe('2026-08-25T20:00:00.000Z');
  });

  it('uses a short monitor cadence instead of the human deadline', () => {
    const now = Date.parse('2026-08-25T20:00:00.000Z');
    expect(resolveNextCheckAt('human_gate', undefined, '2027-08-25T20:00:00.000Z', now))
      .toBe('2026-08-25T20:05:00.000Z');
  });

  it('leaves waits without a deadline on the database default cadence', () => {
    expect(resolveNextCheckAt('external_job', undefined, null)).toBeUndefined();
  });
});
