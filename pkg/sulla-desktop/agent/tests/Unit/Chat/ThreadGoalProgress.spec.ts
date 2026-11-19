// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { ThreadGoalProgress as Progress } from '@pkg/pages/chat/messages/ThreadGoalProgress';

const row = (jobId: string, extra: Record<string, unknown> = {}): any => ({ key: `${ jobId }:0`, jobId, taskIndex: 0, rootThreadId: 'chat-a', threadId: `child-${ jobId }`, parentJobId: null, parentTaskIndex: null, label: 'Same title', state: 'working', endedAt: null, lastActivityAt: '2026-11-15T10:00:00Z', ...extra });
const entry = (jobId: string, extra: Record<string, unknown> = {}): any => ({ messageId: `message-${ jobId }`, item: { jobId, taskIndex: 0, label: jobId, status: 'completed', verdict: 'CHANGES_REQUESTED', outcome: 'Review found a race.', report: '', ...extra } });

describe('current-chat progress', () => {
  it('isolates identical titles in different chats and follows explicit descendants', () => {
    const rows = [row('a'), row('b', { rootThreadId: 'chat-b' }), row('c', { rootThreadId: 'other', parentJobId: 'a', parentTaskIndex: 0 })];
    expect(Progress.scope('chat-a', rows, []).map(r => r.jobId)).toEqual(['a', 'c']);
    expect(Progress.scope('chat-b', rows, []).map(r => r.jobId)).toEqual(['b']);
    expect(Progress.scope(undefined, rows, [])).toEqual([]);
  });
  it('shows descendants when the active chat is a child conversation', () => {
    expect(Progress.scope('child-a', [row('a'), row('c', { parentJobId: 'a', parentTaskIndex: 0 })], []).map(r => r.jobId)).toEqual(['c']);
  });
  it('combines old blocked attempts with exact replacement work and prioritizes live work', () => {
    const groups = Progress.build('chat-a', [row('follow', { followUpOf: { jobId: 'old', taskIndex: 0 } })], [entry('old', { status: 'blocked' }), entry('unrelated')]);
    expect(groups[0].key).toBe('old:0');
    expect(groups[0].steps.map(s => s.key)).toEqual(['follow:0', 'old:0']);
    expect(groups[0].current).toBe(true);
  });
  it('uses durable links without merging unrelated matching labels', () => {
    const groups = Progress.build('chat-a', [], [entry('old'), entry('follow'), entry('separate')], [{ jobId: 'follow', taskIndex: 0, status: 'done', followUpOf: { jobId: 'old', taskIndex: 0 } }]);
    expect(groups.map(g => g.steps.length).sort()).toEqual([1, 2]);
  });
  it('preserves a returned review verdict instead of claiming goal completion', () => {
    const step = Progress.build('chat-a', [row('review', { state: 'done', endedAt: '2026-11-15T10:00:00Z' })], [entry('review')])[0].steps[0];
    expect(Progress.label(step)).toBe('Reported: CHANGES_REQUESTED');
    expect(Progress.detail(step)).toBe('Review found a race.');
    expect(Progress.active(step.row)).toBe(false);
  });
  it('keeps malformed cycles visible exactly once', () => {
    const groups = Progress.build('chat-a', [row('a', { parentJobId: 'b', parentTaskIndex: 0 }), row('b', { parentJobId: 'a', parentTaskIndex: 0 })], []);
    expect(groups.flatMap(g => g.steps.map(s => s.key)).sort()).toEqual(['a:0', 'b:0']);
  });
});
