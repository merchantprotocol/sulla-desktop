import { describe, expect, it } from '@jest/globals';

import { resolveModelSlot } from '../modelSlotRouting';

describe('resolveModelSlot', () => {
  it('routes plain interactive graphs to the primary slot', () => {
    expect(resolveModelSlot({})).toBe('primary');
    expect(resolveModelSlot(null)).toBe('primary');
    expect(resolveModelSlot(undefined)).toBe('primary');
  });

  it('routes work-executing sub-agents stamped primary to the primary slot', () => {
    expect(resolveModelSlot({ isSubAgent: true, modelSlot: 'primary' })).toBe('primary');
  });

  it('routes explicitly stamped observers to the subconscious slot', () => {
    expect(resolveModelSlot({ isSubAgent: true, modelSlot: 'subconscious' })).toBe('subconscious');
  });

  it('keeps the legacy heuristic for unmarked sub-agents', () => {
    expect(resolveModelSlot({ isSubAgent: true })).toBe('subconscious');
  });

  it('ignores invalid modelSlot values and falls back to the heuristic', () => {
    expect(resolveModelSlot({ isSubAgent: true, modelSlot: 'fast' })).toBe('subconscious');
    expect(resolveModelSlot({ modelSlot: 'fast' })).toBe('primary');
  });

  it('explicit slot wins even without the isSubAgent flag', () => {
    expect(resolveModelSlot({ modelSlot: 'subconscious' })).toBe('subconscious');
  });
});
