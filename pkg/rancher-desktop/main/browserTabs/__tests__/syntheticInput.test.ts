import { describe, expect, it } from '@jest/globals';

import { isRecentSyntheticInput, markSyntheticInput } from '../syntheticInput';

describe('syntheticInput', () => {
  it('treats input right after an agent dispatch as synthetic', () => {
    const wc = {} as any;
    const now = Date.now();

    expect(isRecentSyntheticInput(wc, now)).toBe(false);
    markSyntheticInput(wc);
    expect(isRecentSyntheticInput(wc, now + 10)).toBe(true);
    expect(isRecentSyntheticInput(wc, now + 5_000)).toBe(false);
  });

  it('tracks each tab separately', () => {
    const a = {} as any;
    const b = {} as any;

    markSyntheticInput(a);
    expect(isRecentSyntheticInput(b)).toBe(false);
  });
});
