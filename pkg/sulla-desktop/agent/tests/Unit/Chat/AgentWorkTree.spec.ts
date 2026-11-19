// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { AgentWorkTree } from '@pkg/pages/chat/messages/AgentWorkTree';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
const row = (key: string, extra: Partial<AgentStateRow> = {}): AgentStateRow => ({ key, jobId: key.split(':')[0], taskIndex: 0, rootThreadId: 'chat', parentJobId: null, parentTaskIndex: null, label: 'Same title #123', state: 'working', startedAt: null, ...extra } as AgentStateRow);

describe('recorded agent work connections', () => {
  it('connects delegation and follow-up links while leaving matching titles and PRs unlinked', () => {
    const groups = AgentWorkTree.build([row('build:0'), row('review:0', { parentJobId: 'build', parentTaskIndex: 0 }), row('fix:0', { followUpOf: { jobId: 'review', taskIndex: 0 } }), row('unrelated:0')], 'chat');
    expect(groups[0].nodes.map(node => [node.row.key, node.indent])).toEqual([['build:0', 0], ['review:0', 1], ['fix:0', 2]]);
    expect(groups[0].nodes[1].relationship).toBe('Started by Same title #123');
    expect(groups[0].nodes[2].relationship).toBe('Follow-up to Same title #123');
    expect(groups[1]).toMatchObject({ linked: false, title: 'Unlinked work' });
    expect(groups[1].nodes.map(node => node.row.key)).toEqual(['unrelated:0']);
  });
  it('groups a shared explicit task assignment without inventing who started whom', () => {
    const groups = AgentWorkTree.build([row('a:0', { taskId: 'task-1' }), row('b:0', { taskId: 'task-1' })], 'chat');
    expect(groups).toHaveLength(1); expect(groups[0].nodes.map(node => node.indent)).toEqual([0, 0]);
    expect(groups[0].nodes.every(node => node.relationship === 'Assigned to a recorded task')).toBe(true);
  });
  it('keeps completed parents as context, missing references and cycles visible, and excludes other chats', () => {
    const groups = AgentWorkTree.build([row('done:0', { state: 'done' }), row('child:0', { parentJobId: 'done', parentTaskIndex: 0 }), row('orphan:0', { parentJobId: 'missing', parentTaskIndex: 0 }), row('cycle-a:0', { parentJobId: 'cycle-b', parentTaskIndex: 0 }), row('cycle-b:0', { parentJobId: 'cycle-a', parentTaskIndex: 0 }), row('other:0', { rootThreadId: 'other' }), row('cross:0', { followUpOf: { jobId: 'other', taskIndex: 0 } })], 'chat');
    const nodes = groups.flatMap(group => group.nodes);
    expect(nodes.find(node => node.row.key === 'done:0')?.context).toBe(true);
    expect(nodes.find(node => node.row.key === 'orphan:0')?.relationship).toContain('earlier task');
    expect(new Set(nodes.map(node => node.row.key)).size).toBe(nodes.length);
    expect(nodes).toHaveLength(6); expect(nodes.some(node => node.row.key === 'other:0')).toBe(false);
    expect(groups.find(group => !group.linked)?.nodes.map(node => node.row.key)).toContain('cross:0');
  });
});
