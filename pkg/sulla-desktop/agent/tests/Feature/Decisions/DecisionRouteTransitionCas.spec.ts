// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PendingDecisionRepository } from '../../../repositories/PendingDecisionRepository';
import { DecisionRouteTransitionSqlBuilder } from '../../../repositories/DecisionRouteTransitionSqlBuilder';
import { TestDatabase } from '../../Support/TestDatabase';
import type { DecisionRecord } from '@pkg/shared/decisions';

describe('DecisionRouteTransitionSqlBuilder', () => {
  it('uses one open-state and holder-checked JSONB merge per transition, including deadline guards', () => {
    // risk: data integrity — stale holders must not overwrite a later route, and route history must append atomically.
    const builder = new DecisionRouteTransitionSqlBuilder();
    const settlement = builder.settleAs('question', 'question-1', 0, { kind: 'agent', threadId: 'parent-thread' }, 'answered', { answeredBy: { kind: 'agent' } });
    expect(settlement.sql).toContain("COALESCE(record->>'attention','active') NOT IN ('answered','dismissed')");
    expect(settlement.sql).toContain("COALESCE((record#>>'{route,holderIndex}')::integer,-1)=$4");
    expect(settlement.sql).toContain("record#>>ARRAY['route','chain',$4::text,'threadId']=$5");
    expect(settlement.sql).toContain("COALESCE(record#>'{route,history}','[]'::jsonb) || $8::jsonb");
    const timeout = builder.advanceHolder('question', 'question-1', 0, { kind: 'system', threadId: 'parent-thread' }, { holderIndex: 1 }, {
      threadId: 'parent-thread', agentId: 'parent', action: 'timeout', at: 101,
    }, 101);
    expect(timeout.sql).toContain("(record#>>'{route,holderDeadline}')::bigint <= $8");
  });
});

const postgresSuite = TestDatabase.available() ? describe : describe.skip;
const database = new TestDatabase();

postgresSuite('DecisionRouteTransition CAS with real Postgres', () => {
  let repository: PendingDecisionRepository;

  beforeAll(async() => {
    await database.initialize();
    repository = new PendingDecisionRepository(database as any);
  }, 60_000);

  afterAll(async() => database.dispose());

  it('lets exactly one human, holder, or expired-deadline transition win and retains prior history', async() => {
    // risk: authorization — a concurrent human click, current-parent answer and deadline sweep cannot double-settle one question.
    const id = `decision-cas-${ randomUUID() }`;
    const history = [{ threadId: 'previous-thread', agentId: 'previous', action: 'passed', at: 2 }];
    const record: DecisionRecord = {
      id, conversationId: 'asker-thread', channel: 'chat', title: 'Pick one', kind: 'question',
      status: 'pending', attention: 'active', createdAt: 1, expiresAt: 9999,
      route: {
        authority: 'any',
        chain: [
          { threadId: 'parent-thread', channel: 'chat', agentId: 'parent', jobId: 'job-1', taskIndex: 0, kind: 'agent' },
          { threadId: 'root-thread', channel: 'chat', agentId: 'human', kind: 'human' },
        ],
        holderIndex: 0, holderSince: 1, holderDeadline: 100, history,
      },
    };

    await database.query('INSERT INTO human_decisions (id, session_id, status, record) VALUES ($1, $2, $3, $4::jsonb)',
      [id, 'decision-cas-test', record.status, JSON.stringify(record)]);

    const outcomes = await Promise.all([
      repository.settleAs(id, 0, { kind: 'human' }, 'answered', { attention: 'answered', answeredBy: { kind: 'human' } }),
      repository.settleAs(id, 0, { kind: 'agent', threadId: 'parent-thread' }, 'answered',
        { attention: 'answered', answeredBy: { kind: 'agent', threadId: 'parent-thread' } }, [
          { threadId: 'parent-thread', agentId: 'parent', action: 'answered', at: 3 },
        ]),
      repository.settleAs(id, 0, { kind: 'system', threadId: 'parent-thread' }, 'expired', { attention: 'dismissed' }, [
        { threadId: 'parent-thread', agentId: 'parent', action: 'timeout', at: 4 },
      ]),
    ]);

    const [stored] = await database.query<{ record: DecisionRecord }>('SELECT record FROM human_decisions WHERE id=$1', [id]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(stored.record.route?.history[0]).toEqual(history[0]);
    expect(stored.record.route?.history.length).toBe(outcomes[0] ? 1 : 2);
  });
});
