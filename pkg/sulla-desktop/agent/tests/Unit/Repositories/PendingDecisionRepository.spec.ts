// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { PendingDecisionRepository } from '../../../repositories/PendingDecisionRepository';

describe('PendingDecisionRepository', () => {
  it('selects spawn mode and parent job id for escalation route decisions', async() => {
    // risk: authorization — omitted persisted route fields can send a decision to a blocked sync-spawn parent or misclassify a pruned parent as a root chat.
    const task = { jobId: 'child-job', taskIndex: 0, jobStatus: 'running', taskStatus: 'running', spawnMode: 'sync', parentJobId: 'missing-parent-job' };
    const query = vi.fn(async() => [task]);
    const repository = new PendingDecisionRepository({ query });

    await expect(repository.taskForThread('child-thread')).resolves.toMatchObject(task);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(`task.value->>'spawnMode' AS "spawnMode"`);
    expect(sql).toContain('j.parent_job_id AS "parentJobId"');
    expect(params).toEqual(['child-thread']);
  });

  it('reuses the pending Decide approval for a Files publish request', async() => {
    // risk: irreversible side effects — retrying publication must not create duplicate human approvals.
    const record = { id:'decision-1', kind:'approval', status:'pending' } as any;
    const calls: unknown[][] = [];
    const repository = new PendingDecisionRepository({ query: async(_sql, params = []) => { calls.push(params); return [{ record }] } });
    await expect(repository.findApproval('session-1', 'filesPublishRequestId', 'request-1', 123)).resolves.toBe(record);
    expect(calls).toEqual([['session-1', 'filesPublishRequestId', 'request-1', 123]]);
  });

  it('loads a child-thread approval from the root transcript using persisted ancestry', async() => {
    // risk: authorization — a root-chat card must resolve the decision owned by its exact child, not drop it or title-match another thread.
    const record = {
      id: 'child-approval', conversationId: 'child-thread', relatedConversationIds: ['child-thread', 'root-thread'],
      kind: 'approval', status: 'pending',
    } as any;
    const query = vi.fn(async(sql: string, params: unknown[] = []) =>
      sql.includes("COALESCE(record->'relatedConversationIds'") && params[0] === 'root-thread' && Array.isArray(params[1]) && params[1].includes('child-approval')
        ? [{ record }] : []);
    const repository = new PendingDecisionRepository({ query });

    await expect(repository.listTranscriptDecisions('root-thread', ['child-approval'])).resolves.toEqual([record]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("COALESCE(record->'relatedConversationIds'"), ['root-thread', ['child-approval']]);
  });

  it('expires durable Files approvals and returns the changed decision for subscribers', async() => {
    // risk: irreversible side effects — a publish approval that expires after restart must transition to expired so Files rejects it.
    const expired = { id: 'files-expired', kind: 'approval', status: 'expired', payload: { filesPublishRequestId: 'request-1' } } as any;
    const query = vi.fn(async() => [{ record: expired }]);
    const repository = new PendingDecisionRepository({ query });

    await expect(repository.expireOpenDecisions('new-session', 500)).resolves.toEqual([expired]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("NULLIF(record#>>'{payload,filesPublishRequestId}','') IS NOT NULL");
    expect(sql).toContain('RETURNING record');
    expect(params).toEqual(['new-session', 500]);
  });

  it('includes system decision envelopes in every durable answer-mailbox claim and recovery filter', async() => {
    // risk: user communication — a parent answer must survive retries and process recovery without being treated as a human keyboard answer.
    const queries: string[] = [];
    const repository = new PendingDecisionRepository({ query: async(sql) => { queries.push(sql); return [] } });
    await repository.pendingAnswerTargets();
    await repository.startAnswers([{ id: 'decision-answer:q', attempt: 'attempt' }], 'asker');
    await repository.finishAnswers([{ id: 'decision-answer:q', attempt: 'attempt' }], 'asker', true);
    await repository.recoverInterruptedAnswers();
    expect(queries).toHaveLength(4);
    expect(queries.every(sql => sql.includes("kind IN ('human','decision')"))).toBe(true);
  });

  it('stores a non-human answer as a named system decision envelope, never as you/human', async() => {
    // risk: identity integrity — an agent's answer must not be laundered into human keyboard input.
    const record = { id: 'question-agent-answer', conversationId: 'chat', channel: 'sulla-desktop', kind: 'question', status: 'pending', answeredBy: { kind: 'agent', agentId: 'coding-manager', label: 'Coding Manager' } } as any;
    const query = vi.fn(async() => [{ record }]);
    const repository = new PendingDecisionRepository({ query });
    await repository.queueLateAnswer(record, [{ question: 'Color?', selected: ['Blue'] }], '[Decision answered by Coding Manager]\nPick a color\nColor?: Blue');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("SELECT $4,record->>'channel',record->>'conversationId',$9,$10");
    expect(params?.[8]).toBe('system:decision');
    expect(params?.[9]).toBe('decision');
    expect(params?.[4]).toBe('[Decision answered by Coding Manager]\nPick a color\nColor?: Blue');
    expect(JSON.parse(String(params?.[7]))).toEqual(record.answeredBy);
    expect(sql).not.toContain("'you','human'");
  });

  it('requires persisted any-authority and the current holder for every agent late-answer write', async() => {
    // risk: authorization — route-less legacy questions remain human-only even if a caller reaches the repository directly.
    const record = { id: 'legacy-agent-answer', conversationId: 'chat', channel: 'sulla-desktop', kind: 'question', status: 'expired',
      answeredBy: { kind: 'agent', threadId: 'parent-thread' } } as any;
    const query = vi.fn(async() => []);
    const repository = new PendingDecisionRepository({ query });
    await repository.queueLateAnswer(record, [{ question: 'Color?', selected: ['Blue'] }], 'Parent answer');
    await repository.recordJobAnswer(record, [{ question: 'Color?', selected: ['Blue'] }]);

    expect(query).toHaveBeenCalledTimes(2);
    const [chatSql] = query.mock.calls[0];
    const [jobSql] = query.mock.calls[1];
    expect(chatSql).toContain("$8::jsonb->>'kind'='human'");
    expect(chatSql).toContain('$11::integer IS NOT NULL');
    expect(jobSql).toContain("$3::jsonb->>'kind'='human'");
    expect(jobSql).toContain('$5::integer IS NOT NULL');
  });

  it('marks a successfully sent delegated answer delivered only while queued', async() => {
    // risk: user communication — a successful job-mailbox send must not leave a permanently queued decision receipt.
    const query = vi.fn(async() => [{ id: 'decision-1' }]);
    const repository = new PendingDecisionRepository({ query });
    await expect(repository.markJobAnswerDelivered('decision-1')).resolves.toBe(true);
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("jsonb_set(record,'{answerDelivery}','\"delivered\"')");
    expect(sql).toContain("record->>'answerDelivery'='queued'");
    expect(params).toEqual(['decision-1']);
  });
});
