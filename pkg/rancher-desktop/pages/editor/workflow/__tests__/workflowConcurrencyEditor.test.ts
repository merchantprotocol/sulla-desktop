import { describe, expect, it } from '@jest/globals';

import { concurrencyInputValue, concurrencyValueForSave } from '../workflowConcurrencyEditor';

describe('workflow concurrency editor persistence', () => {
  it('round-trips an explicit positive integer', () => {
    expect(concurrencyInputValue({ maxConcurrentRuns: 3 })).toBe('3');
    expect(concurrencyValueForSave('3', { maxConcurrentRuns: 3 })).toBe(3);
  });

  it('preserves a legacy allow definition until the user chooses a finite limit', () => {
    expect(concurrencyInputValue({ concurrencyPolicy: 'allow' })).toBe('');
    expect(concurrencyValueForSave('', { concurrencyPolicy: 'allow' })).toBeUndefined();
    expect(concurrencyValueForSave('4', { concurrencyPolicy: 'allow' })).toBe(4);
  });

  it('normalizes missing and invalid finite values to one', () => {
    expect(concurrencyInputValue({})).toBe('1');
    expect(concurrencyValueForSave('0', {})).toBe(1);
  });
});
