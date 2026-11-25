// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import {
  WorkerChartActivityBuckets,
  WorkerChartGeometry,
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
  it('keeps the two highest-priority children visible and expands the overflow group on request', () => {
    // risk: agent visibility — urgent workers stay reachable without letting a wide fan-out hide the rest
    const layout = new WorkerChartLayout();
    const root = agent('root', 'working', [
      agent('first', 'parked'),
      agent('urgent', 'needs-you'),
      agent('failed', 'failed'),
      agent('fourth', 'working'),
      agent('fifth', 'parked'),
      agent('sixth', 'working'),
    ]);

    const collapsed = layout.layout(root, false, new Set());
    expect(collapsed.rows.map(row => row.kind === 'agent' ? row.agent.id : row.key)).toEqual([
      'root', 'urgent', 'failed', 'group:root',
    ]);
    expect(collapsed.rows.at(-1)).toMatchObject({ kind: 'group', hiddenAgents: [
      { id: 'first' }, { id: 'fourth' }, { id: 'fifth' }, { id: 'sixth' },
    ] });

    const expanded = layout.layout(root, false, new Set(), new Set(['root']));
    expect(expanded.rows.filter(row => row.kind === 'agent').map(row => row.agent.id)).toEqual([
      'root', 'first', 'urgent', 'failed', 'fourth', 'fifth', 'sixth',
    ]);
    expect(expanded.rows.at(-1)).toMatchObject({ kind: 'group', hiddenAgents: [], expanded: true });
    expect(layout.layout(root, true, new Set()).rows).toHaveLength(4);
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

describe('WorkerChartGeometry', () => {
  it('connects a parent to every direct child at the mockup’s stem and elbow endpoints', () => {
    // risk: hierarchy visibility — each child must connect to its actual parent and row center
    const layout = new WorkerChartLayout();
    const geometry = new WorkerChartGeometry();
    const root = agent('root', 'working', [agent('one'), agent('two'), agent('three')]);
    const rows = layout.layout(root, false, new Set()).rows;

    expect(geometry.links(rows, false)).toEqual([
      { kind: 'stem', key: 'stem:root', x: 16.5, y: 24, scaleY: .69 },
      { kind: 'elbow', key: 'elbow:root:one', x: 16.5, y: 40.5 },
      { kind: 'elbow', key: 'elbow:root:two', x: 16.5, y: 66.5 },
      { kind: 'elbow', key: 'elbow:root:three', x: 16.5, y: 92.5 },
    ]);
    expect(geometry.links(rows, true)).toEqual([]);
  });

  it('keeps a grandchild connector scoped to its parent after another sibling collapses', () => {
    // risk: hierarchy visibility — a nested worker must never connect to a grandparent or a removed sibling.
    const layout = new WorkerChartLayout();
    const geometry = new WorkerChartGeometry();
    const root = agent('root', 'working', [
      agent('parent-a', 'working', [agent('grandchild-a', 'working')]),
      agent('finished-sibling', 'done'),
      agent('parent-b', 'working'),
    ]);
    const rows = layout.layout(root, false, new Set(['finished-sibling'])).rows;
    const links = geometry.links(rows, false);

    expect(links).toContainEqual(expect.objectContaining({ kind: 'stem', key: 'stem:parent-a' }));
    expect(links).toContainEqual(expect.objectContaining({ kind: 'elbow', key: 'elbow:parent-a:grandchild-a' }));
    expect(links.some(link => link.kind === 'elbow' && link.key.includes(':root:grandchild-a'))).toBe(false);
    expect(rows.some(row => row.kind === 'agent' && row.agent.id === 'finished-sibling')).toBe(false);
  });

  it('pings only working agents, not waiting, idle, blocked, failed or done agents', () => {
    // risk: status misrepresentation — non-working jobs must not look live
    const geometry = new WorkerChartGeometry();
    const states: WorkerChartState[] = ['working', 'parked', 'idle', 'needs-you', 'failed', 'done'];
    expect(states.filter(state => geometry.shouldPing(state))).toEqual(['working']);
  });
});

describe('WorkerChartActivityBuckets', () => {
  it('ages activity through 44 fixed buckets and drops samples older than the trailing window', () => {
    // risk: misleading live metadata — bars must age forward and exclude stale or future activity
    const buckets = new WorkerChartActivityBuckets();
    const now = 1_700_000_000_000;
    const samples = [
      { timestamp: now - 154_000, value: 2 },
      { timestamp: now - 154_000 + WorkerChartActivityBuckets.bucketMs * 20, value: 3 },
      { timestamp: now, value: 1 },
      { timestamp: now - 154_001, value: 8 },
      { timestamp: now + 1, value: 9 },
    ];

    const current = buckets.values(samples, now);
    expect(current).toHaveLength(44);
    expect(current[0]).toBe(2);
    expect(current[20]).toBe(3);
    expect(current[43]).toBe(1);

    const aged = buckets.values(samples.filter(sample => sample.timestamp <= now), now + WorkerChartActivityBuckets.bucketMs);
    expect(aged[0]).toBe(0);
    expect(aged[19]).toBe(3);
    expect(aged[43]).toBe(1);
  });
});
