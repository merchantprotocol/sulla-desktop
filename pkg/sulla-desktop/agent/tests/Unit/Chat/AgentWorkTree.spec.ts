// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { AgentWorkTree } from '@pkg/pages/chat/messages/AgentWorkTree';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
const row = (key: string, extra: Partial<AgentStateRow> = {}): AgentStateRow => ({ key, jobId: key.split(':')[0], taskIndex: 0, rootThreadId: 'chat', parentJobId: null, parentTaskIndex: null, label: 'Same title #123', state: 'working', startedAt: null, ...extra } as AgentStateRow);

describe('recorded agent work connections', () => {
  it('connects delegation and follow-up links while leaving matching titles and PRs unlinked', () => {
    const groups = AgentWorkTree.build([row('build:0'), row('review:0', { parentJobId: 'build', parentTaskIndex: 0 }), row('fix:0', { followUpOf: { jobId: 'review', taskIndex: 0 } }), row('unrelated:0')], 'chat');
    expect(AgentWorkTree.layout(groups[0].nodes).rows.map(level => level.map(node => node.row.key))).toEqual([['build:0'], ['review:0'], ['fix:0']]);
    expect(groups[0].nodes.find(node => node.row.key === 'review:0')?.links).toEqual([{ key: 'build:0', kind: 'assignment' }]);
    expect(groups[0].nodes.find(node => node.row.key === 'fix:0')?.links).toEqual([{ key: 'review:0', kind: 'follow-up' }]);
    expect(groups[1]).toMatchObject({ linked: false, title: 'Unlinked work' });
    expect(groups[1].nodes.map(node => node.row.key)).toEqual(['unrelated:0']);
  });
  it('groups a shared explicit task assignment without inventing who started whom', () => {
    const groups = AgentWorkTree.build([row('a:0', { taskId: 'task-1' }), row('b:0', { taskId: 'task-1' })], 'chat');
    expect(groups).toHaveLength(1);
    expect(groups[0].nodes.every(node => !node.links.length)).toBe(true);
    expect(AgentWorkTree.layout(groups[0].nodes).style).toBe('list');
  });
  it('keeps completed parents as context, missing references and cycles visible, and excludes other chats', () => {
    const groups = AgentWorkTree.build([row('done:0', { state: 'done' }), row('child:0', { parentJobId: 'done', parentTaskIndex: 0 }), row('orphan:0', { parentJobId: 'missing', parentTaskIndex: 0 }), row('cycle-a:0', { parentJobId: 'cycle-b', parentTaskIndex: 0 }), row('cycle-b:0', { parentJobId: 'cycle-a', parentTaskIndex: 0 }), row('other:0', { rootThreadId: 'other' }), row('cross:0', { followUpOf: { jobId: 'other', taskIndex: 0 } })], 'chat');
    const nodes = groups.flatMap(group => group.nodes);
    expect(nodes.some(node => node.row.key === 'done:0' && node.row.state === 'done')).toBe(true);
    expect(nodes.find(node => node.row.key === 'orphan:0')?.links).toEqual([{ key: 'missing:0', kind: 'assignment' }]);
    expect(AgentWorkTree.layout(groups.find(group => group.nodes.some(node => node.row.key === 'cycle-a:0'))!.nodes).style).toBe('list');
    expect(new Set(nodes.map(node => node.row.key)).size).toBe(nodes.length);
    expect(nodes).toHaveLength(6); expect(nodes.some(node => node.row.key === 'other:0')).toBe(false);
    expect(groups.find(group => !group.linked)?.nodes.map(node => node.row.key)).toContain('cross:0');
  });
  it('keeps every live branch current, then retains only the newest connected settled branch', () => {
    const older = row('older:0', { state: 'done', endedAt: '2026-11-20T12:00:00Z', lastActivityAt: '2026-11-20T12:00:00Z' });
    const parent = row('parent:0', { state: 'done', endedAt: '2026-11-20T13:00:00Z', lastActivityAt: '2026-11-20T13:00:00Z' });
    const child = row('child:0', { state: 'done', parentJobId: 'parent', parentTaskIndex: 0, endedAt: '2026-11-20T14:00:00Z', lastActivityAt: '2026-11-20T14:00:00Z' });
    expect(AgentWorkTree.current([older, parent, child], 'chat').map(item => item.key)).toEqual(['parent:0', 'child:0']);
    const live = row('live:0', { state: 'working' });
    expect(AgentWorkTree.current([older, parent, child, live], 'chat').map(item => item.key)).toEqual(['live:0']);
    const activeParent = row('active-parent:0', { state: 'parked' });
    const recentChild = row('recent-child:0', { state: 'done', parentJobId: 'active-parent', parentTaskIndex: 0 });
    const savedChild = row('saved-child:0', { state: 'done', parentJobId: 'active-parent', parentTaskIndex: 0 });
    expect(AgentWorkTree.current(
      [activeParent, recentChild, savedChild], 'chat',
      new Set(['active-parent:0']), new Set(['active-parent:0', 'recent-child:0']),
    ).map(item => item.key)).toEqual(['active-parent:0', 'recent-child:0']);
    const staleBlocked = row('stale:0', { state: 'blocked', endedAt: '2026-11-20T15:00:00Z', lastActivityAt: '2026-11-20T15:00:00Z' });
    expect(AgentWorkTree.current([parent, child, staleBlocked], 'chat', new Set()).map(item => item.key)).toEqual(['stale:0']);
    expect(AgentWorkTree.build([parent, child], 'chat')).toEqual([]);
    expect(AgentWorkTree.build([parent, child], 'chat', { includeSettled: true })[0].nodes).toHaveLength(2);
  });
});
