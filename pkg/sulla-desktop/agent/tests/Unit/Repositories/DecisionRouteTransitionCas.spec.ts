// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { PendingDecisionRepository } from '../../../repositories/PendingDecisionRepository';
import { DecisionRouteTransitionSqlBuilder } from '../../../repositories/DecisionRouteTransitionSqlBuilder';
import type { DecisionRecord } from '@pkg/shared/decisions';

class DecisionCasDatabase {
  record: DecisionRecord = {
    id: 'question-1', conversationId: 'asker-thread', channel: 'chat', title: 'Pick one', kind: 'question',
    status: 'pending', attention: 'active', createdAt: 1, expiresAt: 9999,
    route: {
      authority: 'any',
      chain: [
        { threadId: 'parent-thread', channel: 'chat', agentId: 'parent', jobId: 'job-1', taskIndex: 0, kind: 'agent' },
        { threadId: 'root-thread', channel: 'chat', agentId: 'human', kind: 'human' },
      ],
      holderIndex: 0, holderSince: 1, holderDeadline: 100,
      history: [{ threadId: 'previous-thread', agentId: 'previous', action: 'passed', at: 2 }],
    },
  };

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [, kind, actorKind, expectedIndex, callerThreadId, status, rawPatch, rawHistory] = params;
    const record = this.record;
    if (record.id !== params[0] || record.kind !== kind) return [];
    if (record.kind === 'approval' ? !['pending', 'deferred'].includes(record.status) : ['answered', 'dismissed'].includes(record.attention ?? 'active')) return [];
    const route = record.route;
    const currentHolder = route?.chain[Number(expectedIndex)];
    if (actorKind !== 'human' && (route?.holderIndex !== Number(expectedIndex) || currentHolder?.threadId !== callerThreadId)) return [];

    if (sql.includes('SET status=$6')) {
      const authorized = actorKind === 'human' ||
        (actorKind === 'system' && status === 'expired') ||
        (actorKind === 'agent' && record.kind === 'question' && status === 'answered' && route?.authority === 'any');
      if (!authorized) return [];
      const history = JSON.parse(String(rawHistory)) as NonNullable<DecisionRecord['route']>['history'];
      this.record = {
        ...record,
        ...JSON.parse(String(rawPatch)),
        status: status as DecisionRecord['status'],
        route: route ? { ...route, history: [...route.history, ...history] } : undefined,
      };
      return [{ id: record.id } as T];
    }

    const routePatch = JSON.parse(String(rawPatch)) as Partial<NonNullable<DecisionRecord['route']>>;
    const historyIndex = sql.includes('|| $7::jsonb') ? 6 : -1;
    const history = historyIndex >= 0 ? JSON.parse(String(params[historyIndex])) as NonNullable<DecisionRecord['route']>['history'] : [];
    this.record = {
      ...record,
      route: route ? { ...route, ...routePatch, history: [...route.history, ...history] } : undefined,
    };
    return [{ id: record.id } as T];
  }
}

describe('DecisionRouteTransitionSqlBuilder and CAS repositories', () => {
  it('builds one open-state, holder-checked JSONB merge per transition, including deadline guards', () => {
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

  it('allows exactly one human, agent, or deadline transition to win concurrently without losing history', async() => {
    // risk: authorization — a concurrent human click, current-parent answer and deadline sweep cannot double-settle one question.
    const db = new DecisionCasDatabase();
    const repository = new PendingDecisionRepository(db);
    const history = db.record.route!.history;
    const results = await Promise.all([
      repository.settleAs('question-1', 0, { kind: 'human' }, 'answered', { attention: 'answered', answeredBy: { kind: 'human' } }),
      repository.settleAs('question-1', 0, { kind: 'agent', threadId: 'parent-thread' }, 'answered',
        { attention: 'answered', answeredBy: { kind: 'agent', threadId: 'parent-thread' } }, [
          { threadId: 'parent-thread', agentId: 'parent', action: 'answered', at: 3 },
        ]),
      repository.settleAs('question-1', 0, { kind: 'system', threadId: 'parent-thread' }, 'expired', { attention: 'dismissed' }, [
        { threadId: 'parent-thread', agentId: 'parent', action: 'timeout', at: 4 },
      ]),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(db.record.route?.history[0]).toEqual(history[0]);
    expect(db.record.route?.history.length).toBeLessThanOrEqual(2);
  });
});
