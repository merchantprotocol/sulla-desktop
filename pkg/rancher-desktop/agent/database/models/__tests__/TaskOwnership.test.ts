import { describe, expect, it } from '@jest/globals';

import {
  hasNonAutonomousTaskLabel,
  normalizeAutonomousTaskOwnership,
} from '../TaskOwnership';

describe('normalizeAutonomousTaskOwnership', () => {
  it.each(['sulla', 'heartbeat', 'dispatcher', 'sulla-desktop'])(
    'routes ordinary sulla-owned todos written by %s to the dispatcher',
    (actor) => {
      expect(normalizeAutonomousTaskOwnership({
        status: 'todo', assignee: 'sulla', labels: [], actor,
      })).toBe('dispatcher');
    },
  );

  it.each(['gated', 'decision', 'human', 'manual', 'no-auto-dispatch', 'MANUAL'])(
    'preserves legacy ownership when the task is labeled %s',
    (label) => {
      expect(normalizeAutonomousTaskOwnership({
        status: 'todo', assignee: 'sulla', labels: [label], actor: 'sulla',
      })).toBe('sulla');
    },
  );

  it('never rewrites explicit human ownership', () => {
    expect(normalizeAutonomousTaskOwnership({
      status: 'todo', assignee: 'human', labels: [], actor: 'sulla',
    })).toBe('human');
  });

  it('leaves non-todo work and non-autonomous actors unchanged', () => {
    expect(normalizeAutonomousTaskOwnership({
      status: 'in_progress', assignee: 'sulla', labels: [], actor: 'sulla',
    })).toBe('sulla');
    expect(normalizeAutonomousTaskOwnership({
      status: 'todo', assignee: 'sulla', labels: [], actor: 'human',
    })).toBe('sulla');
  });

  it('matches non-autonomous labels case-insensitively', () => {
    expect(hasNonAutonomousTaskLabel([' Manual '])).toBe(true);
    expect(hasNonAutonomousTaskLabel(['projects'])).toBe(false);
  });

  describe('on review entry', () => {
    const review = { status: 'in_review', labels: [] as string[], actor: 'sulla', enteringReview: true };

    it.each(['codex-sol-worker', 'sulla', 'Some-Agent'])(
      'hands worker-owned (%s) tasks to the dispatcher so the reviewer can claim them',
      (assignee) => {
        expect(normalizeAutonomousTaskOwnership({ ...review, assignee })).toBe('dispatcher');
      },
    );

    it.each([null, 'dispatcher', 'heartbeat', 'sulla-desktop', 'verifier', 'human'])(
      'keeps already-claimable or human ownership (%s)',
      (assignee) => {
        expect(normalizeAutonomousTaskOwnership({ ...review, assignee })).toBe(assignee);
      },
    );

    it('keeps worker ownership when a human moves the task', () => {
      expect(normalizeAutonomousTaskOwnership({ ...review, assignee: 'codex-sol-worker', actor: 'human' }))
        .toBe('codex-sol-worker');
    });

    it('keeps an assignee set explicitly in the same update', () => {
      expect(normalizeAutonomousTaskOwnership({ ...review, assignee: 'codex-sol-worker', explicitAssignee: true }))
        .toBe('codex-sol-worker');
    });

    it('keeps ownership on non-autonomous labels', () => {
      expect(normalizeAutonomousTaskOwnership({ ...review, assignee: 'codex-sol-worker', labels: ['manual'] }))
        .toBe('codex-sol-worker');
    });

    it('does not touch worker ownership on updates that stay in review', () => {
      expect(normalizeAutonomousTaskOwnership({ ...review, assignee: 'codex-sol-worker', enteringReview: false }))
        .toBe('codex-sol-worker');
    });
  });
});
