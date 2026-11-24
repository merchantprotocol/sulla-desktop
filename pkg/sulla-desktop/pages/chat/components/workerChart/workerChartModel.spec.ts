// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import {
  WorkerChartActivityWindow,
  WorkerChartLayout,
} from './workerChartModel';
import type { WorkerChartAgent, WorkerChartState } from './workerChartModel';

function agent(
  id: string,
  state: WorkerChartState = 'parked',
  children: WorkerChartAgent[] = [],
): WorkerChartAgent {
  return { id, name: id, initials: id.slice(0, 1).toUpperCase(), state, children };
}

describe('WorkerChartLayout', () => {
  it('keeps needs-you and failed siblings visible, fills the collapsed view to two, and expands the full branch', () => {
    // risk: agent visibility — urgent workers must never be hidden by the sibling cap
    const layout = new WorkerChartLayout();
    const root = agent('root', 'working', [
      agent('first', 'parked'),
      agent('urgent', 'needs-you'),
      agent('failed', 'failed'),
      agent('fourth', 'working'),
      agent('fifth', 'parked'),
    ]);

    const collapsed = layout.layout(root, new Set(), false, new Set());
    expect(collapsed.rows.filter(row => row.kind === 'agent').map(row => row.agent.id)).toEqual([
      'root', 'urgent', 'failed',
    ]);
    expect(collapsed.rows.at(-1)).toMatchObject({ kind: 'group', parentId: 'root', hiddenCount: 3, expanded: false });

    const expanded = layout.layout(root, new Set(['root']), false, new Set());
    expect(expanded.rows.filter(row => row.kind === 'agent').map(row => row.agent.id)).toEqual([
      'root', 'first', 'urgent', 'failed', 'fourth', 'fifth',
    ]);
    expect(expanded.rows.at(-1)).toMatchObject({ kind: 'group', hiddenCount: 0, expanded: true });
  });

  it('does not truncate urgent siblings when more than two need attention', () => {
    // risk: agent visibility — urgent count may exceed the normal two-sibling preview
    const layout = new WorkerChartLayout();
    const root = agent('root', 'working', [
      agent('urgent-1', 'needs-you'),
      agent('urgent-2', 'failed'),
      agent('urgent-3', 'needs-you'),
      agent('ordinary-1'),
      agent('ordinary-2'),
    ]);

    const rows = layout.layout(root, new Set(), false, new Set()).rows;
    expect(rows.filter(row => row.kind === 'agent').map(row => row.agent.id)).toEqual([
      'root', 'urgent-1', 'urgent-2', 'urgent-3',
    ]);
    expect(rows.at(-1)).toMatchObject({ kind: 'group', hiddenCount: 2 });
  });

  it('collapses completed descendants into the parent while retaining a completed root marker', () => {
    // risk: finished-agent churn — completed children leave the active tree without hiding the root
    const layout = new WorkerChartLayout();
    const root = agent('root', 'done', [agent('finished-child', 'done'), agent('active-child', 'working')]);

    const beforeCollapse = layout.layout(root, new Set(), false, new Set());
    expect(beforeCollapse.rows.filter(row => row.kind === 'agent').map(row => row.agent.id)).toEqual([
      'root', 'finished-child', 'active-child',
    ]);
    expect(layout.layout(root, new Set(), false, new Set(['finished-child'])).rows
      .filter(row => row.kind === 'agent').map(row => row.agent.id)).toEqual(['root', 'active-child']);
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
