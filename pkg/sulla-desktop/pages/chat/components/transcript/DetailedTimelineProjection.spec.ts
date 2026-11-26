// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(async() => ({ success: false })) } }));
import type { Message } from '../../models/Message';
import { asMessageId } from '../../types/chat';
import { TranscriptReporting } from './toolGroups';
import { DetailedTimelineProjection, DetailedTimelineSegmenter } from './DetailedTimelineProjection';

describe('DetailedTimelineProjection', () => {
  it('places each detailed event between the original standard messages by timestamp', () => {
    // risk: moving work away from its time and changing the Standard transcript while adding Detail.
    const messages = [
      { id: asMessageId('reply'), kind: 'sulla', createdAt: 400, text: 'done', model: 'test-model', tokens: 4 },
      { id: asMessageId('tool'), kind: 'tool', createdAt: 300, tool: 'Shell', recordedToolName: 'exec', desc: 'run', status: 'ok', input: 'echo safe', output: 'safe' },
      { id: asMessageId('thought'), kind: 'thinking', createdAt: 200, thoughts: ['Measure before guessing'], startedAt: 200, completed: true },
      { id: asMessageId('user'), kind: 'user', createdAt: 100, text: 'inspect it' },
    ] satisfies Message[];
    const reporting = new TranscriptReporting();
    const standardEntries = reporting.standardEntries(messages, 'info');
    const standardSnapshot = structuredClone(standardEntries);
    const items = new DetailedTimelineProjection(undefined, reporting).project(messages, standardEntries);

    expect(items.map(item => item.kind)).toEqual(['message', 'header', 'trace', 'trace', 'message']);
    expect(items.filter(item => item.kind === 'trace').map(item => [item.row.kind, item.row.at, item.row.sourceMessageId])).toEqual([
      ['thought', 200, 'thought'], ['tool', 300, 'tool'],
    ]);
    expect(items.filter(item => item.kind === 'message').map(item => item.entry.id)).toEqual(['user', 'reply']);
    expect(standardEntries).toEqual(standardSnapshot);
    expect(items.find(item => item.kind === 'message' && item.entry.id === 'reply')).toMatchObject({
      kind: 'message', entry: { kind: 'card', message: { id: 'reply', text: 'done', model: 'test-model' } },
    });
  });

  it('replaces duplicate debug activity summaries with the full inline tool row', () => {
    // risk: duplicate tool events obscuring whether a command ran once or twice.
    const messages = [
      { id: asMessageId('user'), kind: 'user', createdAt: 1, text: 'run' },
      { id: asMessageId('1_tool_exec'), kind: 'tool', createdAt: 2, tool: 'Shell', recordedToolName: 'exec', desc: 'run', status: 'ok', input: JSON.stringify({ command: 'echo safe' }), output: 'safe' },
      { id: asMessageId('reply'), kind: 'sulla', createdAt: 3, text: 'done', model: 'test-model' },
    ] satisfies Message[];
    const reporting = new TranscriptReporting();
    const entries = reporting.standardEntries(messages, 'info');
    const items = new DetailedTimelineProjection(undefined, reporting).project(messages, entries);

    expect(items.filter(item => item.kind === 'trace').map(item => item.row.kind)).toEqual(['tool']);
    expect(items.filter(item => item.kind === 'message').map(item => item.entry.id)).toEqual(['user', 'reply']);
  });

  it('keeps Standard cards and adds detailed-only events once, in timestamp order', () => {
    // risk: losing Standard items, duplicating detail-only events, or grouping work away from its time.
    const messages = [
      { id: asMessageId('user'), kind: 'user', createdAt: 100, text: 'check the saved report' },
      { id: asMessageId('channel'), kind: 'channel', createdAt: 200, agent: 'Builder', channel: 'build', text: 'Build is green.' },
      { id: asMessageId('memory'), kind: 'memory', createdAt: 250, action: 'saved', memId: 'memory-1', summary: 'Saved the project preference.' },
      { id: asMessageId('heartbeat'), kind: 'heartbeat', createdAt: 300, text: 'Still working.', intervalMinutes: 5 },
      { id: asMessageId('approval'), kind: 'tool_approval', createdAt: 350, reason: 'May I update the file?', command: 'write report.md', decision: 'pending' },
      { id: asMessageId('citation'), kind: 'citation', createdAt: 400, sources: [{ num: 1, title: 'Report', origin: 'Projects/report.md' }] },
      { id: asMessageId('reply'), kind: 'sulla', createdAt: 500, text: 'The report is ready.' },
    ] satisfies Message[];
    const reporting = new TranscriptReporting();
    const standardEntries = reporting.standardEntries(messages, 'info');
    const standardSnapshot = structuredClone(standardEntries);
    const items = new DetailedTimelineProjection(undefined, reporting).project(messages, standardEntries);

    expect(items.map(item => item.at)).toEqual([...items.map(item => item.at)].sort((left, right) => left - right));
    expect(items.filter(item => item.kind === 'trace').map(item => [item.row.kind, item.row.verb])).toEqual([
      ['activity', 'Received'], ['memory', 'saved'], ['heartbeat', 'Heartbeat'], ['approval', 'Approval'], ['source', 'Read report'],
    ]);
    expect(items.filter(item => item.kind === 'message').map(item => item.entry.message.kind)).toEqual([
      'user', 'tool_approval', 'citation', 'sulla',
    ]);
    expect(standardEntries).toEqual(standardSnapshot);
  });

  it('places a returned sub-agent result at its own later timestamp instead of under the launch', () => {
    // risk: a long-running worker result being accumulated above the reply that launched it.
    const messages = [
      { id: asMessageId('user'), kind: 'user', createdAt: 1_000, text: 'review this change' },
      { id: asMessageId('launch'), kind: 'subagent_exchange', createdAt: 2_000, direction: 'to_agent', jobId: 'job-1', taskIndex: 0, conversationId: 'child-1', agentId: 'reviewer', label: 'Review', summary: 'Started review', detail: 'Complete brief', status: 'running' },
      { id: asMessageId('reply'), kind: 'sulla', createdAt: 3_000, text: 'I started a review.' },
      { id: asMessageId('next-user'), kind: 'user', createdAt: 6_000, text: 'What did it find?' },
      // The result message is recorded before the next user turn, but the worker itself finishes after it.
      { id: asMessageId('result'), kind: 'proactive', createdAt: 5_500, headline: 'Review complete', body: '', result: { items: [{
        jobId: 'job-1', taskIndex: 0, threadId: 'child-1', label: 'Review', status: 'completed', endedAt: 7_000,
        purpose: 'review', verdict: 'Done', tone: 'ok', outcome: 'No issues found.', report: 'Full review report',
      }] } },
    ] as unknown as Message[];
    const reporting = new TranscriptReporting();
    const items = new DetailedTimelineProjection(undefined, reporting).project(messages, reporting.standardEntries(messages, 'info'));
    const subagentEvents = items.filter(item => item.kind === 'trace' && ['handoff', 'result'].includes(item.row.kind));

    expect(subagentEvents.map(item => item.kind === 'trace' ? [item.at, item.row.kind, item.row.verb] : [])).toEqual([
      [2_000, 'handoff', 'Handed off to'], [7_000, 'result', 'Result from'],
    ]);
    expect(items.findIndex(item => item.kind === 'message' && item.entry.id === 'next-user')).toBeLessThan(
      items.findIndex(item => item.kind === 'trace' && item.row.kind === 'result'),
    );
    expect(subagentEvents.some(item => item.kind === 'trace' && item.row.kind === 'subagent')).toBe(false);
    const segments = new DetailedTimelineSegmenter().segment(items);
    expect(segments).toHaveLength(2);
    expect(segments[1].items.some(item => item.kind === 'trace' && item.row.kind === 'result')).toBe(true);
  });
});
