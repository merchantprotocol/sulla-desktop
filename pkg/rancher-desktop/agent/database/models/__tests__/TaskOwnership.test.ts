import { describe, expect, it } from '@jest/globals';

import {
  hasNonAutonomousTaskLabel,
  normalizeAutonomousTaskOwnership,
} from '../TaskOwnership';

describe('normalizeAutonomousTaskOwnership', () => {
  it.each(['sulla', 'heartbeat', 'dispatcher'])(
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
});
