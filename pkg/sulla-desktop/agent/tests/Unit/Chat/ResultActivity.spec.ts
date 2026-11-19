// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { resultActivity } from '@pkg/pages/chat/messages/resultActivity';
import type { AgentResultItem } from '@pkg/shared/agentResults/AgentResultCard';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { DecisionRecord } from '@pkg/shared/decisions';

const item = { jobId: 'old', taskIndex: 0, threadId: 'worker-old', status: 'blocked', tone: 'warn', label: 'Fix', report: '', outcome: '', verdict: 'Blocked', purpose: 'fix' } as AgentResultItem;
const row = (jobId: string, state: string, extra = {}) => ({ jobId, taskIndex: 0, key: `${ jobId }:0`, state, threadId: `worker-${ jobId }`, canStop: state !== 'done', followUpOf: { jobId: 'old', taskIndex: 0 }, ...extra } as AgentStateRow);
const question = (extra = {}) => ({ id: 'q', conversationId: 'worker-new', status: 'pending', expiresAt: 200, title: 'Choose a scope', ...extra } as DecisionRecord);
const view = (rows: AgentStateRow[] = [], decisions: DecisionRecord[] = [], items: AgentResultItem[] = []) => resultActivity(item, { rows, decisions, items, now: 100, ownerThreadId: 'parent-chat' });

describe('current ownership of a historical result', () => {
  it('does not turn an unlinked blocker, reply or same-PR task into a human request', () => {
    expect(view().kind).toBe('unknown');
    expect(view([row('new', 'working', { followUpOf: undefined, label: 'Fix #4354' })], [question({ conversationId: 'parent-chat' })]).kind).toBe('unknown');
  });
  it('follows explicit links through multiple differently named attempts', () => {
    const next = row('last', 'parked', { followUpOf: { jobId: 'new', taskIndex: 0 }, waitReason: 'GitHub CI running' });
    expect(view([row('new', 'done'), next])).toMatchObject({ kind: 'waiting', label: 'Waiting for checks', target: next });
  });
  it('updates on queued, working, waiting and completed follow-up snapshots', () => {
    expect(view([row('new', 'queued')]).kind).toBe('working');
    expect(view([row('new', 'working')]).label).toBe('Sulla handling');
    expect(view([row('new', 'parked', { waitReason: 'Subscription limit' })]).kind).toBe('waiting');
    expect(view([row('new', 'done')]).kind).toBe('unknown');
    expect(view([row('new', 'done')], [], [{ ...item, jobId: 'new', status: 'completed', followUpOf: { jobId: 'old', taskIndex: 0 } }]).kind).toBe('completed');
  });
  it('requires a live linked decision, and clears human attention after answer/expiry', () => {
    const rows = [row('new', 'blocked')];
    expect(view(rows, [question()])).toMatchObject({ kind: 'needsYou', decision: { id: 'q' } });
    expect(view(rows, [question({ status: 'answered' })]).kind).toBe('blocked');
    expect(view(rows, [question({ expiresAt: 99 })]).kind).toBe('blocked');
    expect(view(rows, [question({ conversationId: 'unrelated' })]).kind).toBe('blocked');
  });
  it('supports explicit parent-chat decision IDs without attaching other parent questions', () => {
    expect(view([row('new', 'blocked', { decisionIds: ['q'] })], [question({ conversationId: 'parent-chat' })]).kind).toBe('needsYou');
  });
  it('retains completed follow-up evidence in transcript cards after live rows expire', () => {
    const next = { ...item, jobId: 'new', status: 'completed', followUpOf: { jobId: 'old', taskIndex: 0 } } as AgentResultItem;
    expect(view([], [], [next]).kind).toBe('completed');
    expect(view([], [], [{ ...next, status: 'blocked' }]).kind).toBe('blocked');
  });
  it('does not hide an active ancestor when its child finishes', () => {
    expect(view([row('a', 'working'), row('b', 'done', { followUpOf: { jobId: 'a', taskIndex: 0 } })]).kind).toBe('working');
  });
  it('uses durable scoped links after lane expiry, and fresh empty decision links win', () => {
    const records = [{ jobId: 'new', taskIndex: 0, threadId: 'worker-new', status: 'completed', followUpOf: { jobId: 'old', taskIndex: 0 } }];
    expect(resultActivity(item, { rows: [], items: [], decisions: [], records }).kind).toBe('completed');
    const old = { ...item, decisionIds: ['q'] };
    expect(resultActivity(old, { rows: [row('old', 'blocked', { followUpOf: undefined, decisionIds: [] })], items: [old], decisions: [question({ conversationId: 'parent-chat' })], ownerThreadId: 'parent-chat', now: 100 }).kind).not.toBe('needsYou');
    expect(resultActivity(old, { rows: [], items: [old], decisions: [question({ conversationId: 'other-chat' })], ownerThreadId: 'parent-chat', now: 100 }).kind).not.toBe('needsYou');
  });
  it('does not offer navigation to unverified transcript thread IDs', () => {
    const next = { ...item, jobId: 'new', threadId: 'unverified-thread', status: 'completed', followUpOf: { jobId: 'old', taskIndex: 0 } } as AgentResultItem;
    expect(view([], [], [next])).toMatchObject({ kind: 'completed', targetRef: undefined });
  });
  it('keeps quiet/lost ancestors uncertain and trusts a live successful completion', () => {
    expect(view([row('a', 'quiet'), row('b', 'done', { followUpOf: { jobId: 'a', taskIndex: 0 } })]).kind).toBe('unknown');
    expect(resultActivity(item, { rows: [row('new', 'done')], items: [], decisions: [], records: [{ jobId: 'new', taskIndex: 0, status: 'completed', followUpOf: { jobId: 'old', taskIndex: 0 } }] }).kind).toBe('completed');
  });
  it('a settled lane does not turn a blocked returned outcome into success', () => {
    const records = [{ jobId: 'new', taskIndex: 0, status: 'blocked', followUpOf: { jobId: 'old', taskIndex: 0 } }];
    expect(resultActivity(item, { rows: [row('new', 'done')], items: [{ ...item, jobId: 'new', followUpOf: { jobId: 'old', taskIndex: 0 } }], decisions: [], records }).kind).toBe('blocked');
  });
  it('never treats a failed sibling, lost task, cycle or missing live feed as success', () => {
    expect(view([row('a', 'done'), row('b', 'failed')]).kind).toBe('blocked');
    expect(view([row('a', 'lost')]).kind).toBe('unknown');
    expect(view([row('old', 'done', { followUpOf: { jobId: 'old', taskIndex: 0 } })]).kind).toBe('unknown');
    expect(resultActivity(item, { rows: [row('new', 'working')], items: [], decisions: [], unavailable: true }).kind).toBe('unknown');
  });
});
