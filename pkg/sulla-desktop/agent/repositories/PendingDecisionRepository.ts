// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';

import type { DecisionRecord } from '@pkg/shared/decisions';
import { DecisionRouteTransitionSqlBuilder, type DecisionRoutePatch, type DecisionSettlementStatus, type DecisionTransitionActor } from './DecisionRouteTransitionSqlBuilder';
import type { AgentJobTaskTarget } from '../database/models/AgentJobMessagingModel';

interface DecisionQueryClient {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export class PendingDecisionRepository {
  constructor(private readonly client: DecisionQueryClient, private readonly transitions = new DecisionRouteTransitionSqlBuilder()) {}

  async claimHolder(id: string, expectedHolderIndex: number, actor: DecisionTransitionActor, routePatch: DecisionRoutePatch): Promise<boolean> {
    const query = this.transitions.claimHolder('question', id, expectedHolderIndex, actor, routePatch);
    return (await this.client.query(query.sql, query.params)).length > 0;
  }

  async advanceHolder(id: string, expectedHolderIndex: number, actor: DecisionTransitionActor, routePatch: DecisionRoutePatch,
    history: NonNullable<DecisionRecord['route']>['history'][number], deadlineNow?: number): Promise<boolean> {
    const query = this.transitions.advanceHolder('question', id, expectedHolderIndex, actor, routePatch, history, deadlineNow);
    return (await this.client.query(query.sql, query.params)).length > 0;
  }

  async settleAs(id: string, expectedHolderIndex: number, actor: DecisionTransitionActor, status: DecisionSettlementStatus,
    patch: Partial<Omit<DecisionRecord, 'route'>>, history: NonNullable<DecisionRecord['route']>['history'] = []): Promise<boolean> {
    const query = this.transitions.settleAs('question', id, expectedHolderIndex, actor, status, { ...patch, status }, history);
    return (await this.client.query(query.sql, query.params)).length > 0;
  }

  async hasPendingForConversation(conversationId: string, now = Date.now()): Promise<boolean> {
    const rows = await this.client.query<{ id: string }>(`SELECT id FROM human_decisions
      WHERE status IN ('pending','deferred') AND record->>'conversationId'=$1
        AND COALESCE(record->>'attention','') NOT IN ('answered','dismissed')
        AND (record#>>'{payload,answerRoute}'='inbox' OR (record->>'expiresAt')::bigint>$2) LIMIT 1`, [conversationId, now]);
    return rows.length > 0;
  }

  /** Only an exact open question in the same conversation/channel can be reused. */
  async findOpenQuestion(input: Pick<DecisionRecord, 'conversationId' | 'channel' | 'title' | 'questions'>): Promise<DecisionRecord | undefined> {
    const rows = await this.client.query<{ record: DecisionRecord }>(`SELECT record FROM human_decisions
      WHERE record->>'kind'='question' AND record#>>'{payload,answerRoute}'='inbox'
        AND record->>'conversationId'=$1 AND record->>'channel'=$2 AND record->>'title'=$3 AND record->'questions'=$4::jsonb
        AND COALESCE(record->>'attention','') <> 'dismissed'
        AND (COALESCE(record->>'attention','active')='active' OR record->>'answerDelivery' IN ('queued','processing'))
      ORDER BY (record->>'createdAt')::bigint DESC,id DESC LIMIT 1`, [input.conversationId, input.channel, input.title, JSON.stringify(input.questions)]);
    return rows[0]?.record;
  }

  async findById(id: string): Promise<DecisionRecord | undefined> {
    const rows = await this.client.query<{ record: DecisionRecord }>(
      `SELECT record FROM human_decisions WHERE id=$1 LIMIT 1`, [id],
    );
    return rows[0]?.record;
  }

  async openRoutedQuestions(): Promise<DecisionRecord[]> {
    const rows = await this.client.query<{ record: DecisionRecord }>(`SELECT record FROM human_decisions
      WHERE record->>'kind'='question' AND record#>>'{route,authority}'='any'
        AND status IN ('pending','deferred') AND COALESCE(record->>'attention','active')='active'
      ORDER BY (record->>'createdAt')::bigint ASC`);
    return rows.map(row => row.record);
  }

  async ancestry(conversationId: string): Promise<string[]> {
    const rows = await this.client.query<{ id: string }>(`WITH RECURSIVE ancestors(id) AS (
      SELECT $1::text UNION SELECT job.parent_thread_id FROM agent_jobs job
      CROSS JOIN LATERAL jsonb_array_elements(job.tasks) task JOIN ancestors child ON task->>'threadId'=child.id
      WHERE job.parent_thread_id IS NOT NULL
    ) SELECT id FROM ancestors`, [conversationId]);
    return rows.map(row => row.id);
  }

  async taskForThread(threadId: string): Promise<AgentJobTaskTarget | null> {
    const rows = await this.client.query<AgentJobTaskTarget>(`SELECT j.job_id AS "jobId", j.status AS "jobStatus",
        task.ordinality - 1 AS "taskIndex", task.value->>'status' AS "taskStatus", task.value->>'threadId' AS "threadId",
        j.parent_channel AS "parentChannel", j.parent_thread_id AS "parentThreadId",
        j.parent_job_id AS "parentJobId", task.value->>'spawnMode' AS "spawnMode",
        task.value->>'label' AS label, task.value->>'agentId' AS "agentId"
      FROM agent_jobs j CROSS JOIN LATERAL jsonb_array_elements(j.tasks) WITH ORDINALITY AS task(value, ordinality)
      WHERE task.value->>'threadId'=$1 LIMIT 1`, [threadId]);
    return rows[0] ?? null;
  }

  /** Persist expiry transitions and return the authoritative records to every subscribed consumer. */
  async expireOpenDecisions(sessionId: string, now: number): Promise<DecisionRecord[]> {
    const rows = await this.client.query<{ record: DecisionRecord }>(`UPDATE human_decisions SET status = 'expired',
      record = jsonb_set(CASE WHEN record->>'kind'='question' AND NOT record ? 'attention' THEN record || '{"attention":"active"}'::jsonb ELSE record END, '{status}', '"expired"'), updated_at = NOW()
      WHERE status IN ('pending', 'deferred') AND NOT (record->>'kind'='question' AND COALESCE(record#>>'{payload,answerRoute}','')='inbox')
        AND ((record->>'kind'='approval' AND NULLIF(record#>>'{payload,filesPublishRequestId}','') IS NOT NULL AND (record->>'expiresAt')::bigint <= $2)
          OR (NOT (record->>'kind'='approval' AND NULLIF(record#>>'{payload,filesPublishRequestId}','') IS NOT NULL)
            AND (session_id <> $1 OR (record->>'expiresAt')::bigint <= $2)))
      RETURNING record`, [sessionId, now]);
    return rows.map(row => row.record);
  }

  /** Snapshot proven links for existing records before normal job retention removes them. */
  async preserveAncestry(conversationId: string): Promise<void> {
    await this.client.query(`WITH RECURSIVE family(id,path) AS (
      SELECT $1::text, ARRAY[$1::text] UNION ALL
      SELECT task->>'threadId',parent.path || (task->>'threadId') FROM agent_jobs job JOIN family parent ON job.parent_thread_id=parent.id
      CROSS JOIN LATERAL jsonb_array_elements(job.tasks) task
      WHERE task->>'threadId' IS NOT NULL AND NOT (task->>'threadId')=ANY(parent.path)
    ) UPDATE human_decisions decision SET record=jsonb_set(record,'{relatedConversationIds}',COALESCE(record->'relatedConversationIds','[]'::jsonb) || to_jsonb(family.path))
      FROM family WHERE decision.record->>'conversationId'=family.id AND NOT COALESCE(record->'relatedConversationIds','[]'::jsonb) ? $1`, [conversationId]);
  }

  async findConversation(conversationId: string): Promise<{ id: string } | null> {
    const rows = await this.client.query<{ id: string }>(`SELECT id FROM conversation_history WHERE (thread_id=$1 OR id=$1) AND deleted_at IS NULL LIMIT 1`, [conversationId]);
    return rows[0] ?? null;
  }

  async pendingAnswerTargets(): Promise<{ channel: string; threadId: string }[]> {
    return this.client.query(`SELECT DISTINCT receiver_channel AS channel,receiver_thread_id AS "threadId" FROM agent_inbox_messages
      WHERE kind IN ('human','decision') AND message_id LIKE 'decision-answer:%' AND delivered_at IS NULL AND receiver_thread_id IS NOT NULL`);
  }

  async startAnswers(inputs: { id: string; attempt: string }[], conversationId: string): Promise<string[]> {
    const rows = await this.client.query<{ id: string }>(`WITH inputs AS (SELECT * FROM unnest($1::text[],$2::text[]) AS value(id,attempt)), started AS (
      UPDATE agent_inbox_messages inbox SET ids=jsonb_set(ids,'{decisionDelivery}','"processing"') FROM inputs
      WHERE inbox.message_id=inputs.id AND ids->>'answerAttempt'=inputs.attempt AND receiver_thread_id=$3
        AND kind IN ('human','decision') AND delivered_at IS NULL AND COALESCE(ids->>'decisionDelivery','queued')='queued' RETURNING message_id
    ) UPDATE human_decisions SET record=jsonb_set(record,'{answerDelivery}','"processing"'),updated_at=NOW()
      WHERE ('decision-answer:' || id) IN (SELECT message_id FROM started) RETURNING ('decision-answer:' || id) AS id`, [inputs.map(input => input.id), inputs.map(input => input.attempt), conversationId]);
    return rows.map(row => row.id);
  }

  /** A completed turn confirms delivery. Failed/abandoned turns never automatically replay effects. */
  async finishAnswers(inputs: { id: string; attempt: string }[], conversationId: string, completed: boolean): Promise<DecisionRecord[]> {
    const rows = await this.client.query<{ record: DecisionRecord }>(`WITH inputs AS (SELECT * FROM unnest($1::text[],$2::text[]) AS value(id,attempt)), finished AS (
      UPDATE agent_inbox_messages inbox SET delivered_at=NOW(),lease_owner=NULL,lease_expires_at=NULL FROM inputs
      WHERE message_id=inputs.id AND ids->>'answerAttempt'=inputs.attempt AND receiver_thread_id=$3 AND kind IN ('human','decision')
        AND delivered_at IS NULL AND ids->>'decisionDelivery'='processing' RETURNING message_id
    ) UPDATE human_decisions SET record=record || jsonb_build_object('answerDelivery',$4::text,'attention',$5::text),updated_at=NOW()
      WHERE ('decision-answer:' || id) IN (SELECT message_id FROM finished) AND record->>'conversationId'=$3 RETURNING record`,
    [inputs.map(input => input.id), inputs.map(input => input.attempt), conversationId, completed ? 'delivered' : 'interrupted', completed ? 'answered' : 'active']);
    return rows.map(row => row.record);
  }

  async recoverInterruptedAnswers(locallyOwnedThreads: string[] = []): Promise<DecisionRecord[]> {
    const rows = await this.client.query<{ record: DecisionRecord }>(`WITH interrupted AS (
      UPDATE agent_inbox_messages SET delivered_at=NOW(),lease_owner=NULL,lease_expires_at=NULL
      WHERE kind IN ('human','decision') AND message_id LIKE 'decision-answer:%' AND delivered_at IS NULL
        AND NOT (receiver_thread_id=ANY($1::text[])) AND ids->>'decisionDelivery'='processing' AND (lease_expires_at IS NULL OR lease_expires_at < NOW()) RETURNING message_id
    ) UPDATE human_decisions SET record=record || '{"answerDelivery":"interrupted","attention":"active"}'::jsonb,updated_at=NOW()
      WHERE ('decision-answer:' || id) IN (SELECT message_id FROM interrupted) RETURNING record`, [locallyOwnedThreads]);
    return rows.map(row => row.record);
  }

  /** Exact conversation plus its durably recorded delegated threads, never title matching. */
  async listForConversation(conversationId: string, before?: { at: number; id: string }, limit = 100): Promise<DecisionRecord[]> {
    const rows = await this.client.query<{ record: DecisionRecord }>(`WITH RECURSIVE threads(id) AS (
      SELECT $1::text UNION
      SELECT task->>'threadId' FROM agent_jobs job JOIN threads parent ON job.parent_thread_id = parent.id
      CROSS JOIN LATERAL jsonb_array_elements(job.tasks) task WHERE task->>'threadId' IS NOT NULL
    ), scoped AS (
      SELECT id,record, (status NOT IN ('answered','approved','denied') AND COALESCE(record->>'attention','') NOT IN ('dismissed','answered') AND
        ((record->>'kind'='question' AND (record->>'attention'='active' OR status IN ('pending','deferred'))) OR
         (record->>'kind'='approval' AND status IN ('pending','deferred') AND (record->>'expiresAt')::bigint > $5))) AS active
      FROM human_decisions WHERE record->>'conversationId' IN (SELECT id FROM threads) OR COALESCE(record->'relatedConversationIds','[]'::jsonb) ? $1
    ), past AS (
      SELECT id,record FROM scoped WHERE NOT COALESCE(active,false)
        AND ($2::bigint IS NULL OR ((record->>'createdAt')::bigint,id) < ($2::bigint,$3::text))
      ORDER BY (record->>'createdAt')::bigint DESC,id DESC LIMIT $4
    ) SELECT record FROM scoped WHERE active AND $2::bigint IS NULL UNION ALL SELECT record FROM past`,
    [conversationId, before?.at ?? null, before?.id ?? '', Math.min(200, Math.max(1, limit)), Date.now()]);
    return rows.map(row => row.record);
  }

  /** Transcript history can outlive the drawer's first page. Only read cards owned by this thread. */
  async listTranscriptDecisions(conversationId: string, ids: string[]): Promise<DecisionRecord[]> {
    const rows = await this.client.query<{ record: DecisionRecord }>(`SELECT record FROM human_decisions
      WHERE id=ANY($2::text[]) AND (record->>'conversationId'=$1 OR COALESCE(record->'relatedConversationIds','[]'::jsonb) ? $1)`, [conversationId, ids]);
    return rows.map(row => row.record);
  }

  async dismiss(id: string, conversationId: string): Promise<DecisionRecord | undefined> {
    const rows = await this.client.query<{ record: DecisionRecord }>(`UPDATE human_decisions
      SET record = jsonb_set(record, '{attention}', '"dismissed"'), updated_at = NOW()
      WHERE id=$1 AND record->>'conversationId'=$2
        AND status NOT IN ('answered','approved','denied') AND COALESCE(record->>'attention','') <> 'answered'
      RETURNING record`, [id, conversationId]);
    return rows[0]?.record;
  }

  /** The answer and its existing durable inbox message commit together. No send/claim crash gap. */
  async queueLateAnswer(record: DecisionRecord, answers: { question: string; selected: string[] }[], body: string): Promise<DecisionRecord | undefined> {
    const messageId = `decision-answer:${ record.id }`;
    const attempt = randomUUID();
    const actor = record.answeredBy ?? { kind: 'human' as const };
    const humanAnswer = actor.kind === 'human';
    const history = [{
      threadId: actor.kind === 'agent' ? actor.threadId : record.route?.chain.at(-1)?.threadId ?? record.conversationId,
      agentId: actor.kind === 'agent' ? actor.agentId ?? 'agent' : 'human',
      action: 'answered', at: Date.now(),
      ...(actor.note ? { note: actor.note.slice(0, 500) } : {}),
    }];
    const expectedHolder = actor.kind === 'agent' ? record.route?.holderIndex ?? null : null;
    const rows = await this.client.query<{ record: DecisionRecord }>(`WITH chosen AS (
      UPDATE human_decisions SET record=record || jsonb_build_object('attention','answered','answerDelivery','queued','answers',$3::jsonb,'answerAttempt',$7::text,'answeredBy',$8::jsonb,
        'route', COALESCE(record->'route','{}'::jsonb) || jsonb_build_object('history', COALESCE(record#>'{route,history}','[]'::jsonb) || $12::jsonb)), updated_at=NOW()
      WHERE id=$1 AND record->>'kind'='question' AND record->>'conversationId'=$2
        AND (status='expired' OR (status IN ('pending','deferred') AND record#>>'{payload,answerRoute}'='inbox'))
        AND COALESCE(record->>'attention','') NOT IN ('answered','dismissed')
        AND ($8::jsonb->>'kind'='human' OR ($11::integer IS NOT NULL AND record#>>'{route,authority}'='any'
          AND (record#>>'{route,holderIndex}')::integer=$11 AND record#>>ARRAY['route','chain',$11::text,'threadId']=$13))
        AND COALESCE(record#>>'{payload,lateAnswerDelivered}','false') <> 'true'
      RETURNING record
    ), queued AS (
      INSERT INTO agent_inbox_messages(message_id,receiver_channel,receiver_thread_id,sender,kind,body,ids,receiver_agent_id)
      SELECT $4,record->>'channel',record->>'conversationId',$9,$10,$5,$6::jsonb,
        (SELECT agent_id FROM conversation_history WHERE (thread_id=$2 OR id=$2) AND deleted_at IS NULL AND NULLIF(agent_id,'') IS NOT NULL
          ORDER BY CASE WHEN thread_id=$2 THEN 0 ELSE 1 END,last_active_at DESC NULLS LAST,id DESC LIMIT 1) FROM chosen
      ON CONFLICT(message_id) DO UPDATE SET sender=EXCLUDED.sender,kind=EXCLUDED.kind,body=EXCLUDED.body,ids=EXCLUDED.ids,receiver_agent_id=EXCLUDED.receiver_agent_id,delivered_at=NULL,lease_owner=NULL,lease_expires_at=NULL RETURNING message_id
      ) SELECT record FROM chosen`, [record.id, record.conversationId, JSON.stringify(answers), messageId, body, JSON.stringify({ messageId, threadId: record.conversationId, answerAttempt: attempt, decisionDelivery: 'queued' }), attempt, JSON.stringify(actor), humanAnswer ? 'you' : 'system:decision', humanAnswer ? 'human' : 'decision', expectedHolder, JSON.stringify(history), actor.kind === 'agent' ? actor.threadId : '']);
    return rows[0]?.record;
  }

  /** A job answer is saved before the mailbox is touched, so a stopped asker never loses the decision. */
  async recordJobAnswer(record: DecisionRecord, answers: { question: string; selected: string[] }[]): Promise<DecisionRecord | undefined> {
    const actor = record.answeredBy ?? { kind: 'human' as const };
    const history = [{ threadId: actor.kind === 'agent' ? actor.threadId : record.route?.chain.at(-1)?.threadId ?? record.conversationId,
      agentId: actor.kind === 'agent' ? actor.agentId ?? 'agent' : 'human', action: 'answered', at: Date.now(),
      ...(actor.note ? { note: actor.note.slice(0, 500) } : {}) }];
    const expectedHolder = actor.kind === 'agent' ? record.route?.holderIndex ?? null : null;
    const rows = await this.client.query<{ record: DecisionRecord }>(`UPDATE human_decisions SET status='answered',
      record=record || jsonb_build_object('status','answered','attention','answered','answerDelivery','queued','answers',$2::jsonb,'answeredBy',$3::jsonb,
        'route', COALESCE(record->'route','{}'::jsonb) || jsonb_build_object('history', COALESCE(record#>'{route,history}','[]'::jsonb) || $6::jsonb)),updated_at=NOW()
      WHERE id=$1 AND record->>'kind'='question' AND record->>'conversationId'=$4
        AND (status='expired' OR (status IN ('pending','deferred') AND record#>>'{payload,answerRoute}'='inbox'))
        AND COALESCE(record->>'attention','') NOT IN ('answered','dismissed')
        AND ($3::jsonb->>'kind'='human' OR ($5::integer IS NOT NULL AND record#>>'{route,authority}'='any'
          AND (record#>>'{route,holderIndex}')::integer=$5 AND record#>>ARRAY['route','chain',$5::text,'threadId']=$7)) RETURNING record`,
    [record.id, JSON.stringify(answers), JSON.stringify(actor), record.conversationId, expectedHolder, JSON.stringify(history), actor.kind === 'agent' ? actor.threadId : '']);
    return rows[0]?.record;
  }

  async markJobAnswerUnavailable(id: string): Promise<void> {
    await this.client.query(`UPDATE human_decisions SET record=jsonb_set(record,'{answerDelivery}','"unavailable"'),updated_at=NOW()
      WHERE id=$1 AND status='answered' AND record->>'answerDelivery'='queued'`, [id]);
  }

  async markJobAnswerDelivered(id: string): Promise<boolean> {
    const rows = await this.client.query<{ id: string }>(`UPDATE human_decisions SET record=jsonb_set(record,'{answerDelivery}','"delivered"'),updated_at=NOW()
      WHERE id=$1 AND status='answered' AND record->>'answerDelivery'='queued' RETURNING id`, [id]);
    return rows.length > 0;
  }

  /** Files publish approvals outlive the app session that created them; every other approval is session-bound. */
  async findApproval(sessionId: string, key: string, value: string, now: number): Promise<DecisionRecord | undefined> {
    const rows = await this.client.query<{ record: DecisionRecord }>(`SELECT record FROM human_decisions
      WHERE status IN ('pending', 'deferred') AND (session_id=$1 OR $2='filesPublishRequestId') AND record->>'kind'='approval'
        AND record->'payload'->>$2=$3 AND (record->>'expiresAt')::bigint>$4
      ORDER BY updated_at DESC LIMIT 1`, [sessionId, key, value, now]);
    return rows[0]?.record;
  }
}
