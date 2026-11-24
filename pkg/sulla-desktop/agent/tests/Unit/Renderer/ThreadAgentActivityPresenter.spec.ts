// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { ThreadAgentActivityPresenter } from '@pkg/services/agentState/ThreadAgentActivityPresenter';
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
      lastActivityAt: '2026-11-23T17:00:00.000Z', lastCheckinAt: null,
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

  it('uses only fresh unrooted host rows for the undefined-thread fallback', () => {
    // risk: displaying another chat in the host fallback
    const factory = new RowFactory();
    const host = factory.create('host:0', null);
    const expired = factory.create('expired:0', null);
    expired.lastActivityAt = '2026-11-23T16:59:00.000Z';
    const chat = factory.create('chat:0', 'root');
    const projection = new ThreadAgentActivityPresenter().project(snapshot(1, [host, expired, chat]), undefined, at);

    expect(projection.scope).toBe('host');
    expect(projection.agents.map(agent => agent.row.key)).toEqual(['host:0']);
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

  it('bounds observed check-ins and 150-second activity samples, retaining normalized urgency', () => {
    // risk: unbounded live-agent memory and incorrectly prioritized status
    const row = new RowFactory().create('agent:0', 'root');
    const presenter = new ThreadAgentActivityPresenter();
    let projection = presenter.project(snapshot(1, [row]), 'root', at);
    for (let version = 2; version <= 40; version++) {
      row.lastActivityAt = new Date(at - (40 - version) * 1_000).toISOString();
      row.lastCheckinAt = row.lastActivityAt;
      row.lastCheckinSummary = `update ${version}`;
      row.state = version === 40 ? 'blocked' : 'working';
      projection = presenter.project(snapshot(version, [row]), 'root', at);
    }
    expect(projection.agents[0].checkins).toHaveLength(6);
    expect(projection.agents[0].checkins[0].summary).toBe('update 35');
    expect(projection.agents[0].activity).toHaveLength(30);
    expect(projection.agents[0].state).toBe('blocked');
    expect(projection.agents[0].urgency).toBe('needs-you');
    expect(projection.agents[0].initials).toBe('CS');
  });
});
