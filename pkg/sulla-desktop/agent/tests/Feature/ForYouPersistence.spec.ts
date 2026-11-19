// SPDX-License-Identifier: GPL-2.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresAgentInboxRepository } from '../../app/Repositories/PostgresAgentInboxRepository';
import { HumanDecisionRepository } from '../../app/Repositories/HumanDecisionRepository';
import { AgentInbox } from '../../services/AgentInbox';
import { PendingDecisionRepository } from '../../repositories/PendingDecisionRepository';
import { TestDatabase } from '../Support/TestDatabase';

import type { DecisionRecord } from '@pkg/shared/decisions';
const dbDescribe = TestDatabase.available() ? describe : describe.skip;
dbDescribe('For You durable records and exact-target answer delivery', () => {
  const db = new TestDatabase();
  const decisions = new PendingDecisionRepository({ query: (sql, params) => db.query(sql, params) as any });
  const inbox = new PostgresAgentInboxRepository({ select: (sql: string, params: any[]) => db.query(sql, params), run: (sql: string, params: any[]) => db.query(sql, params) } as any);
  const question = (id: string, conversationId: string, extra: any = {}): DecisionRecord => ({ id, conversationId, kind: 'question', title: 'Keep this request', channel: 'shared-channel', status: 'expired', attention: 'active', createdAt: 1, expiresAt: 2, questions: [{ question: 'Choose?', options: [{ label: 'A' }] }], ...extra });
  async function insert(record: DecisionRecord) { await db.query('INSERT INTO human_decisions(id,session_id,status,record) VALUES($1,$2,$3,$4::jsonb)', [record.id, 'fixture', record.status, JSON.stringify(record)]) }
  beforeAll(async() => { await db.initialize() });
  afterAll(async() => { await db.dispose() });
  it('loads every old active request plus a paged history, isolated from other chats', async() => {
    await insert(question('old-active', 'history-root'));
    for (let n = 0; n < 130; n++) await insert(question(`past-${ n }`, 'history-root', { status: 'answered', attention: 'answered', createdAt: n + 10 }));
    await insert(question('other', 'unrelated-root'));
    const first = await decisions.listForConversation('history-root');
    expect(first.some(record => record.id === 'old-active')).toBe(true); expect(first).toHaveLength(101); expect(first.some(record => record.id === 'other')).toBe(false);
    const oldest = first.filter(record => record.status === 'answered').sort((a, b) => a.createdAt - b.createdAt)[0];
    const next = await decisions.listForConversation('history-root', { at: oldest.createdAt, id: oldest.id });
    expect(next).toHaveLength(30); expect(new Set([...first, ...next].map(record => record.id)).size).toBe(131);
  });
  it('keeps proven child ancestry after completed jobs are pruned', async() => {
    await db.query(`INSERT INTO agent_jobs(job_id,status,task_count,parent_thread_id,tasks) VALUES('lineage','completed',1,'parent-root',$1::jsonb)`, [JSON.stringify([{ threadId: 'child-thread', status: 'completed' }])]);
    expect(await decisions.ancestry('child-thread')).toEqual(expect.arrayContaining(['child-thread', 'parent-root']));
    await insert(question('old-child', 'child-thread')); await decisions.preserveAncestry('parent-root');
    await db.query("DELETE FROM agent_jobs WHERE job_id='lineage'");
    expect((await decisions.listForConversation('parent-root')).map(record => record.id)).toContain('old-child');
    expect((await decisions.listForConversation('unrelated-root')).map(record => record.id)).not.toContain('old-child');
  });
  it('commits answer and one stable inbox entry together even with no legacy payload object', async() => {
    const record = question('late-a', 'answer-a'); await insert(record);
    await db.query("INSERT INTO conversation_history(id,thread_id,agent_id,type) VALUES('identity-conversation','answer-a','codex-luna-worker','chat')");
    await db.query("INSERT INTO conversation_history(id,thread_id,agent_id,type,last_active_at) VALUES('obsolete-conversation','answer-a','obsolete-agent','chat','2000-01-01'),('unknown-conversation','answer-a',NULL,'chat',NOW()+interval '1 hour')");
    const answers = [{ question: 'Choose?', selected: ['A'] }];
    expect(await decisions.queueLateAnswer(record, answers, 'Original answer')).toMatchObject({ attention: 'answered', answerDelivery: 'queued', answers });
    expect(await decisions.queueLateAnswer(record, [{ question: 'Choose?', selected: ['B'] }], 'Changed answer')).toBeUndefined();
    expect(await db.query("SELECT body,receiver_agent_id FROM agent_inbox_messages WHERE message_id='decision-answer:late-a'")).toEqual([{ body: 'Original answer', receiver_agent_id: 'codex-luna-worker' }]);
    expect((await decisions.findById('late-a'))?.answers).toEqual(answers);
    const queued = (await decisions.findById('late-a'))!;
    const inputs = [{ id: 'decision-answer:late-a', attempt: queued.answerAttempt! }];
    expect(await decisions.startAnswers(inputs, 'wrong-thread')).toEqual([]);
    expect(await decisions.startAnswers(inputs, 'answer-a')).toEqual(['decision-answer:late-a']);
    expect((await decisions.findById('late-a'))?.answerDelivery).toBe('processing');
    await decisions.finishAnswers([{ ...inputs[0], attempt: 'forged' }], 'answer-a', true);
    expect((await decisions.findById('late-a'))?.answerDelivery).toBe('processing');
    await decisions.finishAnswers(inputs, 'answer-a', true);
    expect((await decisions.findById('late-a'))?.answerDelivery).toBe('delivered');
  });
  it('restores an abandoned answer without replaying it, and fences an explicit retry', async() => {
    const record = question('interrupted', 'interrupted-root'); await insert(record);
    const first = (await decisions.queueLateAnswer(record, [{ question: 'Choose?', selected: ['A'] }], 'saved'))!;
    const old = [{ id: 'decision-answer:interrupted', attempt: first.answerAttempt! }];
    await inbox.claim({ channel: record.channel, threadId: record.conversationId }, 'old-owner');
    await decisions.startAnswers(old, record.conversationId);
    expect(await decisions.recoverInterruptedAnswers()).toEqual([]);
    await db.query("UPDATE agent_inbox_messages SET lease_expires_at=NOW()-interval '1 second' WHERE message_id=$1", [old[0].id]);
    expect(await decisions.recoverInterruptedAnswers([record.conversationId])).toEqual([]);
    expect(await decisions.recoverInterruptedAnswers()).toEqual([expect.objectContaining({ attention: 'active', answerDelivery: 'interrupted', answers: first.answers })]);
    expect((await inbox.claim({ channel: record.channel, threadId: record.conversationId }, 'new-owner')).entries).toEqual([]);
    const retry = (await decisions.queueLateAnswer(record, first.answers!, 'explicit retry'))!;
    expect(retry.answerAttempt).not.toBe(first.answerAttempt);
    await decisions.startAnswers([{ id: old[0].id, attempt: retry.answerAttempt! }], record.conversationId);
    await decisions.finishAnswers(old, record.conversationId, true);
    expect((await decisions.findById(record.id))?.answerDelivery).toBe('processing');
    await decisions.finishAnswers([{ id: old[0].id, attempt: retry.answerAttempt! }], record.conversationId, false);
    expect((await decisions.findById(record.id))?.attention).toBe('active');
  });
  it('keeps ordinary agent messages separate from human answer claims without dropping either', async() => {
    const target = { channel: 'mixed', threadId: 'mixed-thread' };
    for (const kind of ['peer', 'human'] as const) await inbox.enqueue({ target, envelope: { from: 'fixture', kind, body: kind, ids: { messageId: 'mixed-' + kind } } });
    const first = await inbox.claim(target, 'mixed-owner');
    expect(first.entries).toHaveLength(1);
    await inbox.acknowledge(first);
    const second = await inbox.claim(target, 'mixed-owner');
    expect(second.entries).toHaveLength(1);
    expect(new Set([...first.entries, ...second.entries].map(entry => entry.envelope.kind))).toEqual(new Set(['peer', 'human']));
    await inbox.acknowledge(second);
  });
  it('rolls back the decision if its matching inbox row cannot be stored', async() => {
    const record = question('bad-channel', 'failure-root', { channel: null }); await insert(record);
    await expect(decisions.queueLateAnswer(record, [{ question: 'Choose?', selected: ['A'] }], 'Cannot queue')).rejects.toThrow();
    expect((await decisions.findById(record.id))?.attention).toBe('active');
  });
  it('never claims human answers from another thread through a channel-wide mailbox read', async() => {
    for (const threadId of ['mail-a', 'mail-b']) await inbox.enqueue({ target: { channel: 'same', threadId }, envelope: { from: 'you', kind: 'human', body: threadId, ids: { messageId: 'decision-answer:' + threadId } } });
    expect((await inbox.claim({ channel: 'same' }, 'channel-reader')).entries).toHaveLength(0);
    const claim = await inbox.claim({ channel: 'same', threadId: 'mail-a' }, 'exact-a');
    expect(claim.entries.map(entry => entry.envelope.body)).toEqual(['mail-a']);
    const legacyClaim = await inbox.claim({ channel: 'same', threadId: 'mail-b', agentId: 'wrong-flush-agent' }, 'exact-b');
    expect(legacyClaim.entries.map(entry => entry.envelope.body)).toEqual(['mail-b']);
    expect(legacyClaim.entries[0].target.agentId).toBeUndefined();
    expect(await decisions.pendingAnswerTargets()).toEqual(expect.arrayContaining([{ channel: 'same', threadId: 'mail-a' }, { channel: 'same', threadId: 'mail-b' }]));
  });
  it('persists dismissal without granting an approval or changing its execution status', async() => {
    const approval = question('approval', 'approval-root', { kind: 'approval', status: 'pending', expiresAt: Date.now() + 100000 }); await insert(approval);
    expect(await decisions.dismiss('approval', 'wrong')).toBeUndefined();
    expect(await decisions.dismiss('approval', 'approval-root')).toMatchObject({ status: 'pending', attention: 'dismissed' });
    expect((await decisions.listForConversation('approval-root'))[0]).toMatchObject({ status: 'pending', attention: 'dismissed' });
  });
  it('preserves durable questions across expired deadlines and process sessions while approvals still expire', async() => {
    const persistent = question('persistent-pending', 'persistent-thread', { status: 'pending', payload: { answerRoute: 'inbox' } });
    const legacy = question('legacy-pending', 'legacy-thread', { status: 'pending' });
    const approval = question('expired-approval', 'approval-thread', { kind: 'approval', status: 'pending', payload: { answerRoute: 'inbox' } });
    await insert(persistent); await insert(legacy); await insert(approval);
    const repo = new HumanDecisionRepository({ query: (sql, params) => db.query(sql, params) as any });
    await repo.expireForeignOrOverdue('new-process-session', Date.now());
    expect(await decisions.findById(persistent.id)).toMatchObject({ status: 'pending', attention: 'active' });
    expect(await decisions.hasPendingForConversation('persistent-thread')).toBe(true);
    expect(await decisions.findById(legacy.id)).toMatchObject({ status: 'expired' });
    expect(await decisions.findById(approval.id)).toMatchObject({ status: 'expired' });
    const afterRestart = new PendingDecisionRepository({ query: (sql, params) => db.query(sql, params) as any });
    expect((await afterRestart.findOpenQuestion(persistent))?.id).toBe(persistent.id);
  });
  it('finds only the exact original open question, including one whose answer is queued', async() => {
    const record = question('persistent-identity', 'identity-thread', { status: 'pending', payload: { answerRoute: 'inbox' } });
    await insert(record);
    expect((await decisions.findOpenQuestion(record))?.id).toBe(record.id);
    expect(await decisions.findOpenQuestion({ ...record, conversationId: 'another-thread' })).toBeUndefined();
    expect(await decisions.findOpenQuestion({ ...record, questions: [{ question: 'Changed context?', options: [{ label: 'A' }] }] })).toBeUndefined();
    await decisions.queueLateAnswer(record, [{ question: 'Choose?', selected: ['A'] }], 'Saved A');
    expect((await decisions.findOpenQuestion(record))?.id).toBe(record.id);
    expect(await decisions.hasPendingForConversation('identity-thread')).toBe(false);
  });
  it('queues concurrent answers once and replays the saved receipt after restart without interrupting the active receiver', async() => {
    const record = question('persistent-delivery', 'delivery-thread', { status: 'pending', payload: { answerRoute: 'inbox' } });
    await insert(record);
    await db.query("INSERT INTO conversation_history(id,thread_id,agent_id,type) VALUES('persistent-delivery-owner','delivery-thread','account-manager','chat')");
    const answers = [{ question: 'Choose?', selected: ['A'] }];
    const saved = await Promise.all(Array.from({ length: 5 }, () => decisions.queueLateAnswer(record, answers, 'Choose?: A')));
    expect(saved.filter(Boolean)).toHaveLength(1);
    expect((await decisions.findById(record.id))?.answers).toEqual(answers);
    const rows = await db.query("SELECT count(*)::int AS count FROM agent_inbox_messages WHERE message_id='decision-answer:persistent-delivery'");
    expect(rows[0].count).toBe(1);
    let running = true; const seen: string[] = [];
    // A new delivery object reads the pre-existing durable message, as after a restart.
    const afterRestart = new AgentInbox(inbox, {
      isRunning: () => running,
      wake: async(target, _body, entries) => {
        const inputs = entries.map(entry => ({ id: entry.envelope.ids.messageId, attempt: String((entry.envelope.ids as any).answerAttempt) }));
        expect(target.threadId).toBe('delivery-thread'); expect(entries[0].target.agentId).toBe('account-manager');
        expect(await decisions.startAnswers(inputs, target.threadId!)).toHaveLength(1);
        seen.push(entries[0].envelope.body);
        await decisions.finishAnswers(inputs, target.threadId!, true);
        return 'accepted';
      },
    });
    expect(await afterRestart.flush({ channel: record.channel, threadId: record.conversationId })).toBe(0);
    expect(seen).toHaveLength(0); running = false;
    expect(await afterRestart.flush({ channel: record.channel, threadId: record.conversationId })).toBe(1);
    expect(await afterRestart.flush({ channel: record.channel, threadId: record.conversationId })).toBe(0);
    expect(seen).toEqual(['Choose?: A']);
    expect(await decisions.findById(record.id)).toMatchObject({ answers, answerDelivery: 'delivered', attention: 'answered' });
    expect(await decisions.findOpenQuestion(record)).toBeUndefined();
  });
  it('keeps an explicitly dismissed durable question closed without recording an answer', async() => {
    const record = question('persistent-dismissed', 'dismissed-thread', { status: 'pending', payload: { answerRoute: 'inbox' } });
    await insert(record); await decisions.dismiss(record.id, record.conversationId);
    expect(await decisions.findOpenQuestion(record)).toBeUndefined();
    expect(await decisions.hasPendingForConversation(record.conversationId)).toBe(false);
    expect(await decisions.queueLateAnswer(record, [{ question: 'Choose?', selected: ['A'] }], 'A')).toBeUndefined();
    expect((await decisions.findById(record.id))?.answers).toBeUndefined();
  });

});
