import { describe, expect, it } from '@jest/globals';
import {
  clampWipLimit,
  evaluateClaim,
  resolveWipLimits,
  WIP_MAX,
  type WipLimits,
} from '../ProjectAutomationWipLimits';

const unlimited: WipLimits = {
  backlog: null, planning: null, execution: null, review: null,
  blocked: null, terminal: null, manual: null,
};

describe('clampWipLimit', () => {
  it('treats null / empty / zero / negative / NaN as unlimited', () => {
    for (const v of [null, undefined, '', 0, -3, 'abc', NaN]) {
      expect(clampWipLimit(v as any)).toBeNull();
    }
  });
  it('clamps positive integers into the documented range', () => {
    expect(clampWipLimit(1)).toBe(1);
    expect(clampWipLimit(7)).toBe(7);
    expect(clampWipLimit('4')).toBe(4);
    expect(clampWipLimit(9999)).toBe(WIP_MAX);
    expect(clampWipLimit(3.9)).toBe(3);
  });
});

describe('evaluateClaim — own ceiling', () => {
  it('holds a claim when the role is at its own limit', () => {
    const d = evaluateClaim('execution', { execution: 3 }, { ...unlimited, execution: 3 });
    expect(d.allowed).toBe(false);
    expect(d.owningRole).toBe('execution');
    expect(d.reason).toContain('WIP limit (3/3)');
  });
  it('allows a claim below the ceiling', () => {
    const d = evaluateClaim('execution', { execution: 2 }, { ...unlimited, execution: 3 });
    expect(d.allowed).toBe(true);
    expect(d.owningRole).toBeNull();
  });
});

describe('evaluateClaim — downstream-first precedence', () => {
  it('holds fresh execution intake while review is saturated', () => {
    const d = evaluateClaim('execution', { execution: 0, review: 3 }, { ...unlimited, review: 3 });
    expect(d.allowed).toBe(false);
    expect(d.owningRole).toBe('review');
    expect(d.reason).toContain('downstream review');
  });
  it('holds execution while blocked-recovery (repair) is saturated', () => {
    const d = evaluateClaim('execution', { blocked: 2 }, { ...unlimited, blocked: 2 });
    expect(d.allowed).toBe(false);
    expect(d.owningRole).toBe('blocked');
  });
  it('does not let upstream saturation hold a downstream claim', () => {
    // review is downstream of execution: an over-limit execution must not block review intake
    const d = evaluateClaim('review', { execution: 99 }, { ...unlimited, execution: 1, review: 5 });
    expect(d.allowed).toBe(true);
  });
  it('prefers the most-downstream saturated stage as the owner', () => {
    const d = evaluateClaim('execution', { review: 3, blocked: 3 }, { ...unlimited, review: 3, blocked: 3 });
    expect(d.owningRole).toBe('review'); // review is more downstream than blocked
  });
  it('allows work when nothing downstream is saturated', () => {
    const d = evaluateClaim('execution', { review: 1, blocked: 0, terminal: 100 }, { ...unlimited, review: 3 });
    expect(d.allowed).toBe(true);
  });
});

describe('resolveWipLimits', () => {
  it('always resolves every semantic role as unlimited (per-swimlane WIP limits were removed)', async () => {
    await expect(resolveWipLimits()).resolves.toEqual(unlimited);
  });
});
