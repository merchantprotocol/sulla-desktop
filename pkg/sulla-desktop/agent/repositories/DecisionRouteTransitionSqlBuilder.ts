// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionActor, DecisionRecord, DecisionRoute, DecisionRouteHistoryEntry } from '@pkg/shared/decisions';

export type DecisionTransitionActor = DecisionActor | { kind: 'system'; threadId: string };
export type DecisionRoutePatch = Partial<Omit<DecisionRoute, 'history'>>;
export type DecisionSettlementStatus = 'approved' | 'denied' | 'answered' | 'deferred' | 'expired';

export interface DecisionSqlQuery { sql: string; params: unknown[] }

/** Generates the single-statement compare-and-set writes shared by both decision repositories. */
export class DecisionRouteTransitionSqlBuilder {
  claimHolder(recordKind: DecisionRecord['kind'], id: string, expectedHolderIndex: number, actor: DecisionTransitionActor,
    routePatch: DecisionRoutePatch): DecisionSqlQuery {
    return {
      sql: `UPDATE human_decisions SET record = record || jsonb_build_object('route', COALESCE(record->'route','{}'::jsonb) || $6::jsonb), updated_at=NOW()
        WHERE id=$1 AND record->>'kind'=$2 AND ${this.openPredicate(recordKind)} AND ${this.actorPredicate()}
        RETURNING id`,
      params: [id, recordKind, actor.kind, expectedHolderIndex, actor.threadId ?? '', JSON.stringify(routePatch)],
    };
  }

  advanceHolder(recordKind: DecisionRecord['kind'], id: string, expectedHolderIndex: number, actor: DecisionTransitionActor,
    routePatch: DecisionRoutePatch, history: DecisionRouteHistoryEntry, deadlineNow?: number): DecisionSqlQuery {
    return {
      sql: `UPDATE human_decisions SET record = record || jsonb_build_object('route',
          (COALESCE(record->'route','{}'::jsonb) || $6::jsonb) || jsonb_build_object('history', COALESCE(record#>'{route,history}','[]'::jsonb) || $7::jsonb)), updated_at=NOW()
        WHERE id=$1 AND record->>'kind'=$2 AND ${this.openPredicate(recordKind)} AND ${this.actorPredicate()}
          AND ($8::bigint IS NULL OR (record#>>'{route,holderDeadline}')::bigint <= $8)
        RETURNING id`,
      params: [id, recordKind, actor.kind, expectedHolderIndex, actor.threadId ?? '', JSON.stringify(routePatch), JSON.stringify([history]), deadlineNow ?? null],
    };
  }

  settleAs(recordKind: DecisionRecord['kind'], id: string, expectedHolderIndex: number, actor: DecisionTransitionActor,
    status: DecisionSettlementStatus, patch: Partial<Omit<DecisionRecord, 'route'>>, history: DecisionRouteHistoryEntry[] = []): DecisionSqlQuery {
    return {
      sql: `UPDATE human_decisions SET status=$6, record = record || $7::jsonb || jsonb_build_object('route',
          COALESCE(record->'route','{}'::jsonb) || jsonb_build_object('history', COALESCE(record#>'{route,history}','[]'::jsonb) || $8::jsonb)), updated_at=NOW()
        WHERE id=$1 AND record->>'kind'=$2 AND ${this.openPredicate(recordKind)} AND ${this.actorPredicate()}
          AND ${this.settlementPredicate(recordKind)}
        RETURNING id`,
      params: [id, recordKind, actor.kind, expectedHolderIndex, actor.threadId ?? '', status, JSON.stringify(patch), JSON.stringify(history)],
    };
  }

  private openPredicate(recordKind: DecisionRecord['kind']): string {
    return recordKind === 'approval'
      ? "status IN ('pending','deferred')"
      : "COALESCE(record->>'attention','active') NOT IN ('answered','dismissed')";
  }

  private actorPredicate(): string {
    return `($3 IN ('human','system') OR (COALESCE((record#>>'{route,holderIndex}')::integer,-1)=$4
      AND record#>>ARRAY['route','chain',$4::text,'threadId']=$5))`;
  }

  private settlementPredicate(recordKind: DecisionRecord['kind']): string {
    if (recordKind === 'approval') return "($3='human' OR ($3='system' AND $6='expired') OR ($3='agent' AND $6='denied'))";
    return "($3='human' OR ($3='system' AND $6='expired') OR ($3='agent' AND $6='answered' AND COALESCE(record#>>'{route,authority}','human')='any'))";
  }
}
