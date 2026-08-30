import { describe, expect, it } from '@jest/globals';

import { shouldFallbackToRootScroll } from '../browserScrollFallback';

const state = (overrides: Partial<Parameters<typeof shouldFallbackToRootScroll>[0]> = {}) => ({
  hasInnerScrollableTarget: false,
  rootScrollTop:           0,
  rootMaxScrollTop:        2_000,
  deltaY:                  120,
  defaultPrevented:        false,
  ...overrides,
});

describe('shouldFallbackToRootScroll', () => {
  it('falls back when the document can scroll and native scrolling did not move it', () => {
    expect(shouldFallbackToRootScroll(state())).toBe(true);
  });

  it('does not replay a gesture when an inner overflow target can scroll', () => {
    expect(shouldFallbackToRootScroll(state({ hasInnerScrollableTarget: true }))).toBe(false);
  });

  it('does not replay gestures at the document edge or after prevention', () => {
    expect(shouldFallbackToRootScroll(state({ rootScrollTop: 2_000 }))).toBe(false);
    expect(shouldFallbackToRootScroll(state({ deltaY: -120, rootScrollTop: 0 }))).toBe(false);
    expect(shouldFallbackToRootScroll(state({ defaultPrevented: true }))).toBe(false);
  });
});
