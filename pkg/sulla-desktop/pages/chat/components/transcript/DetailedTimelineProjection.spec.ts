// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(async() => ({ success: false })) } }));
import type { Message } from '../../models/Message';
import { asMessageId } from '../../types/chat';
import { TranscriptReporting } from './toolGroups';
import { DetailedTimelineProjection, DetailedTimelineSegmenter } from './DetailedTimelineProjection';

describe('DetailedTimelineProjection', () => {
  it('keeps a working agent from saying it needs the user and places queued waiting after the newest bubble', () => {
    // risk: a working run is shown as blocked and a waiting control is rendered before a queued message.
    const first = { id: asMessageId('first-user'), kind: 'user', createdAt: 100, text: 'first' } as const;
    const newest = { id: asMessageId('newest-user'), kind: 'user', createdAt: 200, text: 'queued' } as const;
    const messages = [first, newest] satisfies Message[];
    const waiting = { message: newest, since: first.createdAt };
    const reporting = new TranscriptReporting();
    const items = new DetailedTimelineProjection(undefined, reporting).project(
      messages, reporting.standardEntries(messages, 'info'), undefined, waiting,
    );
    const waitingItem = items.find(item => item.kind === 'waiting');

    expect(items.filter(item => item.kind === 'message').map(item => item.entry.id)).toEqual(['first-user', 'newest-user']);
    expect(waitingItem).toMatchObject({ kind: 'waiting', at: newest.createdAt, since: first.createdAt });
    expect(items.find(item => item.kind === 'header' )?.header.metadata).not.toContain('waiting on you');
    expect(items.findIndex(item => item.kind === 'message' && item.entry.id === 'newest-user')).toBeLessThan(
      items.findIndex(item => item.kind === 'waiting'),
    );
  });

  it('labels only pending approvals and blocked workers as waiting on you', () => {
    // risk: misleading next-action state when approval is not pending or a worker has no blocker.
    const user = { id: asMessageId('user'), kind: 'user', createdAt: 100, text: 'run it' } as const;
    const approval = { id: asMessageId('approval'), kind: 'tool_approval', createdAt: 200,
      reason: 'Needs approval', command: 'write report.md', decision: 'pending' } as const;
    const approvalMessages = [user, approval] satisfies Message[];
    const reporting = new TranscriptReporting();
    const approvalItems = new DetailedTimelineProjection(undefined, reporting).project(
      approvalMessages, reporting.standardEntries(approvalMessages, 'info'),
    );
    expect(approvalItems.find(item => item.kind === 'header')?.header.metadata).toContain('waiting on you');

    const launch = { id: asMessageId('launch'), kind: 'subagent_exchange', createdAt: 150, direction: 'to_agent',
      jobId: 'blocked-job', taskIndex: 0, conversationId: 'child', agentId: 'worker', label: 'Worker',
      summary: 'Started', detail: 'brief', status: 'running' } as const;
    const result = { id: asMessageId('result'), kind: 'proactive', createdAt: 300, headline: 'Blocked', body: '',
      result: { items: [{ jobId: 'blocked-job', taskIndex: 0, threadId: 'child', label: 'Worker', status: 'blocked',
        endedAt: 300, purpose: 'review', verdict: 'Blocked', tone: 'warning', outcome: 'Needs a decision', report: 'Full report' }] } } as unknown as Message;
    const blockedMessages = [user, launch, result] satisfies Message[];
    const blockedItems = new DetailedTimelineProjection(undefined, reporting).project(
      blockedMessages, reporting.standardEntries(blockedMessages, 'info'),
    );
    expect(blockedItems.find(item => item.kind === 'header')?.header.metadata).toContain('waiting on you');
  });

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

  it('replaces Standard tool activity only, while retaining other Standard activity beside trace rows', () => {
    // risk: suppressing an ordinary Standard activity because another trace row shares its source.
    const messages = [
      { id: asMessageId('user'), kind: 'user', createdAt: 1, text: 'run' },
      { id: asMessageId('tool'), kind: 'tool', createdAt: 2, tool: 'Shell', recordedToolName: 'exec', desc: 'run', status: 'ok', input: 'echo safe' },
      { id: asMessageId('status'), kind: 'thinking', createdAt: 3, thoughts: ['Preparing the response'], reportingActivity: 'status', completed: true },
      { id: asMessageId('reply'), kind: 'sulla', createdAt: 4, text: 'done' },
    ] satisfies Message[];
    const reporting = new TranscriptReporting();
    const entries = reporting.entries(messages, 'debug');
    const items = new DetailedTimelineProjection(undefined, reporting).project(messages, entries);

    expect(items.filter(item => item.kind === 'message' && item.entry.kind === 'activity')
      .map(item => item.entry.sourceId)).toEqual(['status']);
    expect(items.filter(item => item.kind === 'trace').map(item => item.row.kind)).toEqual(['tool', 'thought']);
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

  it('renders adjacent assistant replies as separate Standard messages', () => {
    // risk: adjacent replies being merged and dropping a distinct answer from either transcript level.
    const messages = [
      { id: asMessageId('user'), kind: 'user', createdAt: 100, text: 'first question' },
      { id: asMessageId('reply-one'), kind: 'sulla', createdAt: 200, text: 'First answer.' },
      { id: asMessageId('reply-two'), kind: 'sulla', createdAt: 300, text: 'A separate follow-up answer.' },
    ] satisfies Message[];
    const reporting = new TranscriptReporting();
    const standardEntries = reporting.standardEntries(messages, 'info');
    const items = new DetailedTimelineProjection(undefined, reporting).project(messages, standardEntries);

    expect(standardEntries.map(entry => entry.sourceId)).toEqual(['user', 'reply-one', 'reply-two']);
    expect(items.filter(item => item.kind === 'message').map(item => item.entry.id)).toEqual(['user', 'reply-one', 'reply-two']);
    expect(items.filter(item => item.kind === 'message' && item.entry.kind === 'card' && item.entry.message.kind === 'sulla')
      .map(item => item.entry.message.text)).toEqual(['First answer.', 'A separate follow-up answer.']);
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
