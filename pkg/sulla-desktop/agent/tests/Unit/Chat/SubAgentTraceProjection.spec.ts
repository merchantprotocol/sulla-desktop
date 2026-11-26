// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn() } }));

import { DetailedTraceProjection } from '@pkg/pages/chat/components/transcript/DetailedTraceProjection';
import { TranscriptReporting } from '@pkg/pages/chat/components/transcript/toolGroups';
import { ReplyCitationProjection } from '@pkg/pages/chat/components/transcript/ReplyCitationProjection';
import { SubAgentTraceProjection } from '@pkg/pages/chat/components/transcript/SubAgentTraceProjection';
import { ThreadAgentActivityPresenter } from '@pkg/services/agentState/ThreadAgentActivityPresenter';
import type { Message } from '@pkg/pages/chat/models/Message';
import { asMessageId } from '@pkg/pages/chat/types/chat';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { AgentResultItem } from '@pkg/shared/agentResults/AgentResultCard';

const reporting = new TranscriptReporting();
const projection = new DetailedTraceProjection();
const launch = Object.freeze({ kind: 'subagent_exchange', id: asMessageId('launch'), createdAt: 2_000,
  direction: 'to_agent', jobId: 'job-1', taskIndex: 0, conversationId: 'child-1', agentId: 'worker',
  label: 'Inspect', summary: 'Started', detail: 'Entire\nbrief', status: 'running' } as const);
const reply = { kind: 'sulla', id: asMessageId('reply'), text: 'Done', createdAt: 3_000 } as const;
const source = { kind: 'citation', id: asMessageId('citation'), createdAt: 2_900, sources: [{ num: 1, title: 'Evidence', origin: 'Files' }] } as const;
const result = (status: AgentResultItem['status'], extra: Partial<AgentResultItem> = {}): AgentResultItem => Object.freeze({
  jobId: 'job-1', taskIndex: 0, threadId: 'child-1', label: 'Inspect', status, endedAt: 7_000,
  purpose: 'review', verdict: 'Done', tone: 'ok', outcome: 'Checked.', report: 'Entire\nreport', ...extra,
});
const card = (...items: AgentResultItem[]): Message => Object.freeze({
  kind: 'proactive', id: asMessageId('result'), createdAt: 7_500, headline: 'Finished', body: '', agentReporting: 'brief',
  result: Object.freeze({ items: Object.freeze(items) as unknown as AgentResultItem[] }),
});
const live = (state: AgentStateRow['state']): AgentStateRow => ({
  key: 'job-1:0', jobId: 'job-1', taskIndex: 0, rootThreadId: 'parent', threadId: 'child-1',
  parentJobId: null, parentTaskIndex: null, depth: 0, agentId: 'worker', label: 'Inspect',
  visibility: 'hidden', state, stateReason: null, startedAt: new Date(2_000).toISOString(), endedAt: null,
  lastActivityAt: new Date(5_000).toISOString(), lastCheckinAt: new Date(5_000).toISOString(),
  lastCheckinSummary: 'Latest update', killedByHuman: false, waitingOnChildren: 0, canMessage: true, canStop: true, canOpen: true,
});
const rows = (messages: readonly Message[], agents: readonly AgentStateRow[] = []) =>
  projection.project(messages, reporting.standardEntries(messages, 'info'), { agents }).flatMap(turn => turn.rows).filter(row => row.kind === 'subagent');

describe('Option A transcript policy', () => {
  it('excludes agent launch, native progress, and ordinary returns at info and fatal without hiding replies or sources', () => {
    // risk: leaking trace-only activity into the Standard/Brief transcript.
    const native = { kind: 'subagent', id: asMessageId('native'), createdAt: 4_000, name: 'native', desc: 'Working', status: 'running', steps: [] } as const;
    const legacy = { kind: 'proactive', id: asMessageId('legacy'), createdAt: 5_000, headline: 'Background agents failed', body: 'Older job failed' } as const;
    const messages = [launch, source, reply, native, legacy, card(result('completed'))];
    for (const level of ['info', 'fatal'] as const) {
      expect(reporting.standardEntries(messages, level).map(entry => entry.id)).toEqual(level === 'info' ? ['citation', 'reply'] : ['reply']);
    }
    expect(reporting.standardEntries(messages, 'debug')).toEqual(reporting.standardEntries(messages, 'info'));
  });

  it('keeps decision-linked results reachable at every level', () => {
    // risk: dropping the only route to a child agent approval or question.
    for (const level of ['info', 'fatal', 'debug'] as const) {
      const linked = result('blocked', { decisionIds: ['pending-approval'] });
      const lateLinked = result('blocked', { taskIndex: 1 });
      const unrelated = result('error', { taskIndex: 2 });
      const [entry] = reporting.standardEntries([card(linked, lateLinked, unrelated)], level, item => item === lateLinked);
      expect(entry).toMatchObject({ id: asMessageId('result'), message: { result: { items: [linked, lateLinked] } } });
    }
  });

  it.each([['completed', 'returned'], ['error', 'failed'], ['stopped', 'stopped'], ['blocked', 'blocked']] as const)(
    'coalesces launch, live activity, and a %s result across turns into the same row',
    (status, expected) => {
      // risk: duplicated or stale job status and loss of the full brief/report.
      const [started] = rows([launch, reply]);
      expect(started.status).toBe('starting');
      expect(rows([launch, reply], [live('working')])).toMatchObject([{ id: started.id, status: 'working', note: 'Latest update' }]);
      const messages = Object.freeze([launch, reply, Object.freeze({ kind: 'user', id: asMessageId('new-turn'), text: 'status?', createdAt: 6_000 } as const), card(result(status))]);
      const before = JSON.stringify(messages);
      const settled = rows(messages, [live('working')]);
      expect(settled).toMatchObject([{ id: started.id, status: expected, anchorEntryId: 'reply', note: 'Checked.' }]);
      expect(settled[0].payload!.serialize()).toContain('Entire\nbrief');
      expect(settled[0].payload!.serialize()).toContain('Entire\nreport');
      expect(JSON.stringify(messages)).toBe(before);
    },
  );

  it('uses a structured blocker rather than its coarse failed exchange, then recognizes a reopened run', () => {
    // risk: calling for the wrong corrective action on a cooperative blocker or a live retry.
    const exchange = { ...launch, id: asMessageId('coarse-return'), createdAt: 7_100,
      direction: 'from_agent', status: 'failed' } as const;
    const messages = [launch, exchange, card(result('blocked', { problem: 'Waiting for a decision' }))];
    expect(rows(messages)).toMatchObject([{ status: 'blocked', note: 'Waiting for a decision' }]);
    const restarted = { ...live('working'), startedAt: new Date(7_200).toISOString() };
    expect(rows(messages, [restarted])).toMatchObject([{ status: 'working' }]);
  });

  it('joins a thread-only exchange without collapsing two tasks in the same spawn batch', () => {
    // risk: attributing the wrong outcome to a parallel worker.
    const exchange = { ...launch, id: asMessageId('thread-only'), jobId: undefined, direction: 'from_agent', status: 'done' } as const;
    const other = result('error', { taskIndex: 1, threadId: 'child-2' });
    expect(rows([launch, exchange, card(result('completed'), other)]).map(row => row.status)).toEqual(['returned', 'failed']);
  });
});

describe('Option A Detailed sub-agent row', () => {
  it('keeps one row per job that changes in place from starting through parked, no check-in and returned', () => {
    // risk: a second card per job or a status word outside the approved seven.
    const base = [launch, reply] as const;
    const ids = new Set<string>();
    const seen: string[] = [];
    for (const agents of [[], [live('working')], [{ ...live('parked'), waitReason: 'CI running' }], [live('quiet')]]) {
      const projected = rows(base, agents);
      expect(projected).toHaveLength(1);
      ids.add(projected[0].id);
      seen.push(projected[0].status);
    }
    const settled = rows([...base, card(result('completed'))], [live('working')]);
    expect(settled).toHaveLength(1);
    ids.add(settled[0].id);
    seen.push(settled[0].status);
    expect(ids.size).toBe(1);
    expect(seen).toEqual(['starting', 'working', 'working', 'quiet', 'returned']);
    // A parked worker's second line is its latest check-in, like any working row.
    expect(rows(base, [{ ...live('parked'), waitReason: 'CI running' }])[0].note).toBe('Latest update');
  });

  it('marks the row with the same initials the worker chart draws for that agent', () => {
    // risk: the trace row and the worker chart pointing at different agents.
    const luna = { ...launch, agentId: 'codex-luna-worker' };
    const [row] = rows([luna, reply], [{ ...live('working'), agentId: 'codex-luna-worker' }]);
    expect(row.subagent?.marker).toBe(ThreadAgentActivityPresenter.initials('codex-luna-worker', row.id));
    expect(row.subagent?.marker).toBe('CL');
  });

  it('falls back to the chart key for the marker when the agent id is missing', () => {
    // risk: an unnamed agent getting a different marker in the trace than in the chart.
    const unnamed = { ...launch, agentId: undefined };
    const [row] = rows([unnamed, reply], [{ ...live('working'), agentId: null }]);
    expect(row.subagent?.marker).toBe(ThreadAgentActivityPresenter.initials(null, 'job-1:0'));
  });

  it('names the job a relaunch follows and heads the report with outcome and run time', () => {
    // risk: losing which failed job a relaunch replaces, or a wrong total run time.
    const [row] = rows([launch, reply, card(result('completed', { startedAt: 2_000, durationMs: 220_000, followUpOf: { jobId: 'job-0', taskIndex: 1 } }))]);
    expect(row.subagent?.followUpOf).toEqual({ jobId: 'job-0', taskIndex: 1 });
    expect(row.payload!.serialize()).toMatch(/REPORT · completed .+ · 3m 40s\n/);
  });

  it('summarizes the turn sub-agents by status word', () => {
    // risk: the turn header miscounting returned versus working jobs.
    const second = { ...launch, id: asMessageId('launch-2'), taskIndex: 1, conversationId: 'child-2', createdAt: 2_100 };
    const messages = [launch, second, reply, card(result('completed'))];
    const [turn] = projection.project(messages, reporting.standardEntries(messages, 'info'), { agents: [] });
    expect(turn.agentSummary).toBe('2 agents: 1 returned, 1 starting');
    expect(SubAgentTraceProjection.summary([])).toBeUndefined();
    expect(turn.waitingOnYou).toBeUndefined();
    const blocked = [launch, reply, card(result('blocked', { problem: 'Needs a decision' }))];
    expect(projection.project(blocked, reporting.standardEntries(blocked, 'info'))[0].waitingOnYou).toBe(true);
  });

  it('numbers each Read step on the trace to match the reply sources', () => {
    // risk: [n] in the reply pointing at a different source than the trace step.
    const cited = { kind: 'citation', id: asMessageId('cites'), createdAt: 2_900, sources: [
      { num: 1, title: 'plan-review.md', origin: 'Projects/sulla-desktop/plan-review.md' },
      { num: 2, title: 'Vue docs', origin: 'vuejs.org', url: 'https://vuejs.org/guide' },
    ] } as const;
    const messages = [cited, reply];
    const reads = projection.project(messages, reporting.standardEntries(messages, 'info')).flatMap(turn => turn.rows).filter(row => row.kind === 'source');
    expect(reads.map(row => [row.cite, row.verb, row.target])).toEqual([[1, 'Read report', 'plan-review.md'], [2, 'Read source', 'Vue docs']]);
    expect(projection.project(messages, reporting.standardEntries(messages, 'info'))[0].sourceCount).toBe(2);
  });
});

describe('reply source association', () => {
  it('associates sources before or after a reply, but does not attach across a new user turn', () => {
    // risk: attributing evidence to a reply it does not support.
    const after = { ...source, id: asMessageId('after'), createdAt: 3_001 };
    const nextUser = { kind: 'user', id: asMessageId('next-question'), text: 'Next?', createdAt: 4_000 } as const;
    const nextSource = { ...source, id: asMessageId('next-source'), createdAt: 4_500 };
    const entries = reporting.standardEntries([launch, source, reply, after, nextUser, nextSource], 'info');
    const projected = new ReplyCitationProjection().project(entries);
    expect(projected.byReply.get(reply.id)).toEqual([source, after]);
    expect(projected.attached.has(nextSource.id)).toBe(false);
  });
});
