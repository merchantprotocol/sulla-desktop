// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import {
  WorkerChartActivityWindow,
  WorkerChartLayout,
} from '../../../../pages/chat/components/workerChart/workerChartModel';
import type { WorkerChartAgent, WorkerChartState } from '../../../../pages/chat/components/workerChart/workerChartModel';

function agent(
  id: string,
  state: WorkerChartState = 'parked',
  children: WorkerChartAgent[] = [],
): WorkerChartAgent {
  return { id, name: id, initials: id.slice(0, 1).toUpperCase(), state, children };
}

describe('WorkerChartLayout', () => {
  it('gives every child agent its own row when a parent has more than three children, in order and at any depth', () => {
    // risk: agent visibility — no agent may ever be hidden behind a "+N" group
    const layout = new WorkerChartLayout();
    const root = agent('root', 'working', [
      agent('first', 'parked'),
      agent('urgent', 'needs-you'),
      agent('failed', 'failed'),
      agent('fourth', 'working', [
        agent('nested-1'), agent('nested-2'), agent('nested-3'), agent('nested-4'), agent('nested-5'),
      ]),
      agent('fifth', 'parked'),
      agent('sixth', 'working'),
    ]);

    const rows = layout.layout(root, false, new Set()).rows;
    expect(rows.map(row => row.agent.id)).toEqual([
      'root', 'first', 'urgent', 'failed', 'fourth',
      'nested-1', 'nested-2', 'nested-3', 'nested-4', 'nested-5',
      'fifth', 'sixth',
    ]);
    expect(rows.every(row => row.kind === 'agent')).toBe(true);
    expect(layout.layout(root, true, new Set()).rows).toHaveLength(12);
  });

  it('collapses completed descendants into the parent while retaining a completed root marker', () => {
    // risk: finished-agent churn — completed children leave the active tree without hiding the root
    const layout = new WorkerChartLayout();
    const root = agent('root', 'done', [agent('finished-child', 'done'), agent('active-child', 'working')]);

    const beforeCollapse = layout.layout(root, false, new Set());
    expect(beforeCollapse.rows.map(row => row.agent.id)).toEqual([
      'root', 'finished-child', 'active-child',
    ]);
    expect(layout.layout(root, false, new Set(['finished-child'])).rows
      .map(row => row.agent.id)).toEqual(['root', 'active-child']);
  });
});

describe('WorkerChartActivityWindow', () => {
  it('includes only real samples inside the exact trailing 150-second window, in time order', () => {
    // risk: misleading live metadata — stale or future activity must not appear in the sparkline
    const window = new WorkerChartActivityWindow();
    const now = 1_700_000_000_000;
    const samples = [
      { timestamp: now + 1, value: 9 },
      { timestamp: now, value: 4 },
      { timestamp: now - 150_001, value: 2 },
      { timestamp: now - 149_999, value: 3 },
      { timestamp: now - 150_000, value: 1 },
    ];

    expect(window.recentSamples(samples, now)).toEqual([
      { timestamp: now - 150_000, value: 1 },
      { timestamp: now - 149_999, value: 3 },
      { timestamp: now, value: 4 },
    ]);
  });
});
