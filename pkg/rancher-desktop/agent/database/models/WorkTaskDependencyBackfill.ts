import { postgresClient } from '../PostgresClient';
import { WorkTaskDependencyModel, type DependencyRelationType } from './WorkTaskDependencyModel';

/**
 * Conservative, dry-run-first backfill of first-class task dependencies from
 * two recognizable legacy conventions:
 *
 *   1. parent/child tasks (work_tasks.parent_id) — the parent depends_on each
 *      active child ('requires'), matching the existing dispatcher rule that a
 *      parent is not claimable while any child is incomplete.
 *   2. HOLD comments (work_task_comments.body ILIKE 'HOLD%') — proposed ONLY
 *      when the comment body names an EXISTING task id. HOLD comments that name
 *      no resolvable task are reported for manual review; no link is guessed.
 *
 * planTaskDependencyBackfill() is read-only and emits an audit report.
 * applyTaskDependencyBackfill() writes via WorkTaskDependencyModel.create(),
 * which is idempotent and rejects cycles/self-links, so re-runs are safe.
 */

export interface BackfillProposal {
  dependentTaskId: string;
  dependsOnTaskId: string;
  relationType: DependencyRelationType;
  source: 'parent_child' | 'hold_comment';
  evidence: string;
}

export interface UnresolvedHold {
  taskId: string;
  commentId: string;
  body: string;
}

export interface BackfillSkip {
  proposal: BackfillProposal;
  reason: string;
}

export interface BackfillAudit {
  dryRun: boolean;
  proposals: BackfillProposal[];
  unresolvedHolds: UnresolvedHold[];
  created: BackfillProposal[];
  skipped: BackfillSkip[];
  summary: string;
}

async function collectProposals(): Promise<{ proposals: BackfillProposal[]; unresolvedHolds: UnresolvedHold[] }> {
  const proposals: BackfillProposal[] = [];
  const unresolvedHolds: UnresolvedHold[] = [];

  const parentChild = await postgresClient.query<{ parent_id: string; child_id: string }>(
    `SELECT c.parent_id AS parent_id, c.id AS child_id
       FROM work_tasks c
       JOIN work_tasks p ON p.id = c.parent_id AND p.archived = false
      WHERE c.parent_id IS NOT NULL AND c.archived = false`);
  for (const row of parentChild) {
    proposals.push({
      dependentTaskId: row.parent_id,
      dependsOnTaskId:  row.child_id,
      relationType:    'requires',
      source:          'parent_child',
      evidence:        'work_tasks.parent_id',
    });
  }

  const ids = new Set(
    (await postgresClient.query<{ id: string }>(`SELECT id FROM work_tasks WHERE archived = false`)).map(r => r.id));
  const holds = await postgresClient.query<{ id: string; task_id: string; body: string }>(
    `SELECT id, task_id, body FROM work_task_comments WHERE archived = false AND body ILIKE 'HOLD%'`);
  for (const h of holds) {
    const target = (h.body.match(/[A-Za-z0-9_-]{2,}/g) ?? []).find(t => t !== h.task_id && ids.has(t));
    if (target) {
      proposals.push({
        dependentTaskId: h.task_id,
        dependsOnTaskId:  target,
        relationType:    'blocks',
        source:          'hold_comment',
        evidence:        h.body.slice(0, 240),
      });
    } else {
      unresolvedHolds.push({ taskId: h.task_id, commentId: h.id, body: h.body.slice(0, 240) });
    }
  }
  return { proposals, unresolvedHolds };
}

/** Read-only audit of what a backfill WOULD create. Writes nothing. */
export async function planTaskDependencyBackfill(): Promise<BackfillAudit> {
  const { proposals, unresolvedHolds } = await collectProposals();
  const pc = proposals.filter(p => p.source === 'parent_child').length;
  const hc = proposals.filter(p => p.source === 'hold_comment').length;
  return {
    dryRun: true, proposals, unresolvedHolds, created: [], skipped: [],
    summary: `DRY RUN — ${ proposals.length } proposed link(s) (${ pc } parent-child, ${ hc } HOLD-comment); `
      + `${ unresolvedHolds.length } HOLD comment(s) need manual review. No links written.`,
  };
}

/** Apply the backfill. Idempotent; cycles/self-links/invalid targets are skipped. */
export async function applyTaskDependencyBackfill(opts: { actor?: string } = {}): Promise<BackfillAudit> {
  const { proposals, unresolvedHolds } = await collectProposals();
  const created: BackfillProposal[] = [];
  const skipped: BackfillSkip[] = [];
  for (const p of proposals) {
    try {
      await WorkTaskDependencyModel.create({
        dependentTaskId:     p.dependentTaskId,
        dependsOnTaskId:     p.dependsOnTaskId,
        relationType:        p.relationType,
        acceptanceCondition: null,
        actor:               opts.actor ?? 'backfill-0078',
      });
      created.push(p);
    } catch (err: any) {
      skipped.push({ proposal: p, reason: err?.message ?? String(err) });
    }
  }
  return {
    dryRun: false, proposals, unresolvedHolds, created, skipped,
    summary: `APPLIED — ${ created.length } link(s) created, ${ skipped.length } skipped (existing/cycle/invalid), `
      + `${ unresolvedHolds.length } HOLD comment(s) need manual review.`,
  };
}
