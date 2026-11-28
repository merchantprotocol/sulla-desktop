// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

import { ThreadAgentActivityPresenter } from '@pkg/services/agentState/ThreadAgentActivityPresenter';
import { ThreadAgentActivityMapper } from '@pkg/pages/chat/composables/ThreadAgentActivityMapper';
import { ThreadAgentActivitySnapshotScheduler } from '@pkg/pages/chat/composables/ThreadAgentActivitySnapshotScheduler';
import { WorkerChartActivityBuckets } from '@pkg/pages/chat/components/workerChart/workerChartModel';
import type { AgentStateRow, AgentStateSnapshot } from '@pkg/shared/agentState/AgentStateSnapshot';

class RowFactory {
  create(key: string, rootThreadId: string | null, parentKey: string | null = null, threadId: string | null = null): AgentStateRow {
    const [jobId, task = '0'] = key.split(':');
    const [parentJobId, parentTask = ''] = parentKey?.split(':') ?? [];
    return {
      key, jobId, taskIndex: Number(task), parentJobId: parentJobId || null,
      parentTaskIndex: parentJobId ? Number(parentTask) : null, rootThreadId, threadId,
      depth: parentKey ? 1 : 0, agentId: 'codex-sol-worker', label: key,
      visibility: 'hidden', state: 'working', stateReason: null, killedByHuman: false,
      waitingOnChildren: 0, startedAt: null, endedAt: null,
      lastActivityAt: '2026-11-23T17:00:00.000Z', actionCount: 0, lastCheckinAt: null,
      lastCheckinSummary: null, canMessage: true, canStop: true, canOpen: true,
    };
  }
}

const at = Date.parse('2026-11-23T17:02:00.000Z');
const snapshot = (version: number, rows: AgentStateRow[]): AgentStateSnapshot => ({ version, generatedAt: new Date(at).toISOString(), rows });

describe('ThreadAgentActivityPresenter', () => {
  it('keeps a root chat private while retaining a same-root orphan under its root', () => {
    // risk: cross-chat agent data disclosure
    const factory = new RowFactory();
    const direct = factory.create('direct:0', 'root');
    const orphan = factory.create('orphan:0', 'root', 'missing:0');
    const other = factory.create('other:0', 'another-chat');
    other.decisionIds = ['private-decision'];
    direct.decisionIds = ['current-decision'];
    const projection = new ThreadAgentActivityPresenter().project(snapshot(1, [direct, orphan, other]), 'root', at);

    expect(projection.scope).toBe('root');
    expect(projection.agents.map(agent => agent.row.key)).toEqual(['direct:0', 'orphan:0']);
    expect(projection.decisionIds).toEqual(['current-decision']);
  });

  it('limits an exact child-tab match to its descendants within the proven root', () => {
    // risk: cross-thread agent data disclosure
    const factory = new RowFactory();
    const manager = factory.create('manager:0', 'root');
    const child = factory.create('child:0', 'root', manager.key, 'child-tab');
    const descendant = factory.create('descendant:0', 'root', child.key);
    const sibling = factory.create('sibling:0', 'root', manager.key);
    const unrelated = factory.create('unrelated:0', 'other-root', null, 'other-tab');
    const projection = new ThreadAgentActivityPresenter().project(snapshot(1, [manager, child, descendant, sibling, unrelated]), 'child-tab', at);

    expect(projection.scope).toBe('child');
    expect(projection.agents.map(agent => agent.row.key)).toEqual(['child:0', 'descendant:0']);
    expect(projection.agents.some(agent => agent.row.key === 'unrelated:0')).toBe(false);
  });

  it('refuses an ambiguous child-thread match spanning multiple roots', () => {
    // risk: guessing ownership can leak a different chat's agents
    const factory = new RowFactory();
    const firstRoot = factory.create('first:0', 'root-a', null, 'shared-tab');
    const secondRoot = factory.create('second:0', 'root-b', null, 'shared-tab');
    const projection = new ThreadAgentActivityPresenter().project(snapshot(1, [firstRoot, secondRoot]), 'shared-tab', at);

    expect(projection.scope).toBe('empty');
    expect(projection.agents).toEqual([]);
  });

  it('returns an empty projection for an undefined thread with multiple shared null-root rows', () => {
    // risk: displaying unowned or cross-chat agent data without a selected thread
    const factory = new RowFactory();
    const host = factory.create('host:0', null);
    host.decisionIds = ['host-decision'];
    const sharedHost = factory.create('shared-host:0', null);
    sharedHost.decisionIds = ['shared-host-decision'];
    const chat = factory.create('chat:0', 'root');
    const otherChat = factory.create('other:0', 'other-root');
    const projection = new ThreadAgentActivityPresenter().project(snapshot(1, [host, sharedHost, chat, otherChat]), undefined, at);

    expect(projection.scope).toBe('empty');
    expect(projection.roots).toEqual([]);
    expect(projection.agents).toEqual([]);
    expect(projection.decisionIds).toEqual([]);
    expect(projection.pendingDecisionIds).toEqual([]);
  });

  it('clears observations on thread switch and rejects stale snapshots', () => {
    // risk: stale agent check-ins leaking into a newly selected chat
    const factory = new RowFactory();
    const first = factory.create('first:0', 'first-chat');
    first.lastCheckinAt = new Date(at - 1_000).toISOString();
    first.lastCheckinSummary = 'private earlier update';
    const presenter = new ThreadAgentActivityPresenter();
    const next = factory.create('next:0', 'next-chat');
    const sameSnapshot = snapshot(4, [first, next]);
    presenter.project(sameSnapshot, 'first-chat', at);
    const current = presenter.project(sameSnapshot, 'next-chat', at);
    const stale = presenter.project(snapshot(3, [first]), 'next-chat', at);

    expect(current.agents.map(agent => agent.row.key)).toEqual(['next:0']);
    expect(stale).toBe(current);
    expect(stale.agents[0].checkins).toEqual([]);
  });

  it('bounds check-ins, retains all count deltas in the chart window, and normalizes urgency', () => {
    // risk: losing real activity counts or incorrectly prioritizing status
    const row = new RowFactory().create('agent:0', 'root');
    const presenter = new ThreadAgentActivityPresenter();
    let projection = presenter.project(snapshot(1, [row]), 'root', at);
    for (let version = 2; version <= 40; version++) {
      row.lastActivityAt = new Date(at - (40 - version) * 1_000).toISOString();
      row.actionCount = version;
      row.lastCheckinAt = row.lastActivityAt;
      row.lastCheckinSummary = `update ${version}`;
      row.state = version === 40 ? 'blocked' : 'working';
      projection = presenter.project(snapshot(version, [row]), 'root', at);
    }
    expect(projection.agents[0].checkins).toHaveLength(6);
    expect(projection.agents[0].checkins[0].summary).toBe('update 35');
    expect(projection.agents[0].activity).toHaveLength(39);
    expect(projection.agents[0].state).toBe('blocked');
    expect(projection.agents[0].urgency).toBe('needs-you');
    expect(projection.agents[0].initials).toBe('CS');
  });

  it('keeps the last six check-ins independent of the 150-second activity window and stable marker', () => {
    // risk: losing useful status history or changing the chart/status marker when a label changes
    const row = new RowFactory().create('stable:0', 'root');
    row.agentId = null;
    row.lastCheckinAt = new Date(at - 300_000).toISOString();
    row.lastCheckinSummary = 'earlier check-in';
    const presenter = new ThreadAgentActivityPresenter();
    const first = presenter.project(snapshot(1, [row]), 'root', at).agents[0];

    row.label = 'renamed label';
    const second = presenter.project(snapshot(2, [row]), 'root', at).agents[0];

    expect(second.checkins).toEqual([{ at: row.lastCheckinAt, summary: 'earlier check-in' }]);
    expect(second.initials).toBe(first.initials);
  });

  it('bins every cumulative action delta, including a 500-action burst, in the worker chart', () => {
    // risk: activity bursts between snapshots must not collapse or flatten in the chart
    const row = new RowFactory().create('actions:0', 'root');
    const presenter = new ThreadAgentActivityPresenter();
    const mapper = new ThreadAgentActivityMapper({} as any);
    const buckets = new WorkerChartActivityBuckets();
    presenter.project(snapshot(1, [row]), 'root', at);

    row.actionCount = 4;
    presenter.project(snapshot(2, [row]), 'root', at + 6_000);
    row.lastActivityAt = new Date(at + 7_000).toISOString();
    const unchanged = presenter.project(snapshot(3, [row]), 'root', at + 7_000);
    expect(unchanged.agents[0].activity).toHaveLength(1);
    row.actionCount = 507;
    const projection = presenter.project(snapshot(4, [row]), 'root', at + 10_500);
    const chart = mapper.chartRoot(projection, 'root')!;
    const values = buckets.values(chart.children?.[0].activity, at + 10_500);

    expect(values[42]).toBe(4);
    expect(values[43]).toBe(503);
    expect(values.reduce((total, value) => total + value, 0)).toBe(507);
    expect(buckets.scale(5, 503)).toBeGreaterThan(0);
    expect(buckets.scale(5, 503)).toBeLessThan(1);
    expect(buckets.scale(503, 503)).toBe(1);
    expect(buckets.scale(0, 503)).toBe(0);
  });

  it('uses the live snapshot count and exact last-action label, then goes quiet when idle', () => {
    // risk: chat status must show the actual run count and safe current-action label
    const row = new RowFactory().create('status:0', 'root');
    row.actionCount = 500;
    row.lastAction = { kind: 'tool', label: 'Bash', at: new Date(at).toISOString() };
    const presenter = new ThreadAgentActivityPresenter();
    const mapper = new ThreadAgentActivityMapper({} as any);
    const active = presenter.project(snapshot(1, [row]), 'root', at);

    expect(mapper.runningActionStatus(active)).toEqual({ running: true, count: 500, label: 'Bash' });

    const idleRow = { ...row, state: 'parked' as const };
    const idle = presenter.project(snapshot(2, [idleRow]), 'root', at + 1_000);
    expect(mapper.runningActionStatus(idle)).toEqual({ running: false, count: 0, label: null });
  });

  it('coalesces working snapshots to one-second updates without dropping cumulative counts', () => {
    // risk: renderer throttling must never lose actions from cumulative snapshots
    vi.useFakeTimers();
    try {
      const factory = new RowFactory();
      const rows = Array.from({ length: 300 }, (_, index) => factory.create(`scheduled:${index}`, 'root'));
      const initial = snapshot(1, rows);
      let shown = initial;
      let clock = 0;
      let snapshotPublishes = 0;
      let clockTicks = 0;
      const scheduler = new ThreadAgentActivitySnapshotScheduler(initial, {
        publish: (next, at) => { shown = next; clock = at; snapshotPublishes++; },
        tick: at => { clock = at; clockTicks++; },
      });
      scheduler.observe(initial, 'root');
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1_000);
      expect(snapshotPublishes).toBe(1);
      expect(clockTicks).toBe(1);

      const four = snapshot(2, initial.rows.map(row => row.key === 'scheduled:0' ? { ...row, actionCount: 4 } : row));
      scheduler.observe(four, 'root');
      vi.advanceTimersByTime(500);
      const seven = snapshot(3, initial.rows.map(row => row.key === 'scheduled:0' ? { ...row, actionCount: 7 } : row));
      scheduler.observe(seven, 'root');
      expect(shown.rows.find(row => row.key === 'scheduled:0')?.actionCount).toBe(0);

      vi.advanceTimersByTime(500);
      expect(shown.rows.find(row => row.key === 'scheduled:0')?.actionCount).toBe(7);
      expect(snapshotPublishes).toBe(2);

      const idle = snapshot(4, initial.rows.map(row => ({ ...row, state: 'parked' as const, actionCount: row.key === 'scheduled:0' ? 507 : 0 })));
      scheduler.observe(idle, 'root');
      expect(shown.rows.find(row => row.key === 'scheduled:0')?.actionCount).toBe(507);
      expect(snapshotPublishes).toBe(3);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(50_000);
      expect(vi.getTimerCount()).toBe(0);
      const idleClock = clock;
      const unrelated = new RowFactory().create('unrelated:0', 'another-root');
      scheduler.observe(snapshot(5, [...idle.rows.map(row => ({ ...row })), unrelated]), 'root');
      vi.advanceTimersByTime(2_000);
      expect(shown.version).toBe(4);
      expect(clock).toBe(idleClock);
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues one worker-chart avatar blip per action-count delta and none for a zero-delta idle row', () => {
    // risk: avatars must reflect every real action without faking activity for idle agents
    vi.useFakeTimers();
    try {
      const factory = new RowFactory();
      const working = factory.create('active:0', 'root');
      const idle = factory.create('idle:0', 'root');
      idle.state = 'parked';
      const initial = snapshot(1, [working, idle]);
      const blips: string[] = [];
      const scheduler = new ThreadAgentActivitySnapshotScheduler(initial, {
        publish: () => undefined,
        actionBlips: agentKeys => blips.push(...agentKeys),
      });

      scheduler.observe(initial, 'root');
      vi.advanceTimersByTime(500);
      expect(blips).toEqual([]);

      const burst = snapshot(2, initial.rows.map(row => row.key === 'active:0' ? { ...row, actionCount: 5 } : row));
      scheduler.observe(burst, 'root');
      vi.advanceTimersByTime(500);
      expect(blips).toEqual(['active:0', 'active:0', 'active:0', 'active:0', 'active:0']);

      const unchangedIdle = snapshot(3, burst.rows.map(row => ({ ...row })));
      scheduler.observe(unchangedIdle, 'root');
      vi.advanceTimersByTime(1_000);
      expect(blips).toHaveLength(5);
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves every source state while prioritizing only blocked and failed rows', () => {
    // risk: incorrect worker state or urgency in the chart/status line
    const states: AgentStateRow['state'][] = ['working', 'queued', 'quiet', 'parked', 'blocked', 'failed', 'lost', 'stopped', 'done'];
    const rows = states.map((state, index) => {
      const row = new RowFactory().create(`state-${ index }:0`, 'root');
      row.state = state;
      return row;
    });
    const projection = new ThreadAgentActivityPresenter().project(snapshot(1, rows), 'root', at);

    expect(projection.agents.map(agent => agent.state)).toEqual(states);
    expect(projection.agents.map(agent => agent.urgency)).toEqual(['normal', 'normal', 'normal', 'normal', 'needs-you', 'failed', 'normal', 'normal', 'normal']);
  });

  it('prioritizes only pending decisions tied to an in-scope agent thread or explicit owner link', () => {
    // risk: urgent status from another chat or an expired/resolved decision
    const linked = new RowFactory().create('linked:0', 'root');
    linked.threadId = 'agent-tab';
    linked.decisionIds = ['owner-decision', 'expired-decision'];
    const unlinked = new RowFactory().create('unlinked:0', 'root');
    const decision = (id: string, conversationId: string, status: 'pending' | 'expired', expiresAt = at + 60_000) => ({
      id, conversationId, channel: 'agent', title: id, kind: 'question' as const, status, createdAt: at - 1_000, expiresAt,
    });
    const decisions = [
      decision('owner-decision', 'root', 'pending'),
      decision('agent-thread-decision', 'agent-tab', 'pending'),
      decision('foreign-decision', 'other-root', 'pending'),
      decision('expired-decision', 'root', 'expired', at),
    ];
    const projection = new ThreadAgentActivityPresenter().project(snapshot(1, [linked, unlinked]), 'root', at, decisions);

    expect(projection.pendingDecisionIds).toEqual(['owner-decision', 'agent-thread-decision']);
    expect(projection.agents.find(agent => agent.row.key === 'linked:0')?.urgency).toBe('needs-you');
    expect(projection.agents.find(agent => agent.row.key === 'unlinked:0')?.urgency).toBe('normal');
  });
});
