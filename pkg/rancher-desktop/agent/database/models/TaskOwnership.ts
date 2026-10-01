export const TASK_ASSIGNEES = {
  dispatcher:  'dispatcher',
  desktop:     'sulla-desktop',
  heartbeat:   'heartbeat',
  human:       'human',
  legacySulla: 'sulla',
} as const;

export const AUTONOMOUS_TASK_ASSIGNEES = [
  TASK_ASSIGNEES.heartbeat,
  TASK_ASSIGNEES.dispatcher,
  TASK_ASSIGNEES.desktop,
] as const;

export const AUTONOMOUS_TASK_ACTORS = [
  TASK_ASSIGNEES.legacySulla,
  TASK_ASSIGNEES.heartbeat,
  TASK_ASSIGNEES.dispatcher,
  TASK_ASSIGNEES.desktop,
] as const;

export const NON_AUTONOMOUS_TASK_LABELS = [
  'gated',
  'decision',
  'human',
  'manual',
  'no-auto-dispatch',
] as const;

export interface TaskOwnershipInput {
  status:                 string;
  assignee:               string | null;
  labels:                 readonly string[] | null;
  actor:                  string;
  semanticRole?:          WorkLaneSemanticRole;
  executionEntryLaneKey?: string | null;
  /** True only on the update that moves the task into a review-role lane. */
  enteringReview?:        boolean;
  /** True when the caller set assignee in this same update. */
  explicitAssignee?:      boolean;
}

/** Assignees the protected review claim already accepts. */
const REVIEW_CLAIMABLE_ASSIGNEES = new Set<string>([...AUTONOMOUS_TASK_ASSIGNEES, 'verifier']);

export function hasNonAutonomousTaskLabel(labels: readonly string[] | null): boolean {
  const denied = new Set<string>(NON_AUTONOMOUS_TASK_LABELS);

  return (labels ?? []).some(label => denied.has(label.trim().toLowerCase()));
}

/**
 * Keep task authorship separate from durable queue ownership. `sulla` is an
 * actor identity retained for attribution, not a mechanical queue assignee.
 */
export function normalizeAutonomousTaskOwnership(input: TaskOwnershipInput): string | null {
  if (input.enteringReview) return reviewEntryOwnership(input);
  const status = input.status.trim();
  const semanticCatalogReady = input.semanticRole !== undefined;
  const isExecutionEntry = semanticCatalogReady
    ? input.semanticRole === 'execution' && status === input.executionEntryLaneKey?.trim()
    : status.toLowerCase() === 'todo';
  if (!isExecutionEntry) return input.assignee;
  if (input.assignee?.trim().toLowerCase() !== TASK_ASSIGNEES.legacySulla) return input.assignee;
  const actor = input.actor.trim().toLowerCase();
  if (!AUTONOMOUS_TASK_ACTORS.some(candidate => candidate === actor)) return input.assignee;
  if (hasNonAutonomousTaskLabel(input.labels)) return input.assignee;

  return TASK_ASSIGNEES.dispatcher;
}
import type { WorkLaneSemanticRole } from './WorkLaneDefinitionModel';

/**
 * Entering review ends the executor's ownership: verification is independent
 * work claimed by the dispatcher. A worker that stamped its own id on the task
 * (e.g. `codex-sol-worker`) would otherwise sit outside the review claim
 * forever. Human ownership, explicit reassignment in the same update, and
 * non-autonomous labels are preserved.
 */
function reviewEntryOwnership(input: TaskOwnershipInput): string | null {
  const assignee = input.assignee?.trim().toLowerCase();
  if (!assignee || REVIEW_CLAIMABLE_ASSIGNEES.has(assignee)) return input.assignee;
  if (assignee === TASK_ASSIGNEES.human) return input.assignee;
  if (input.explicitAssignee) return input.assignee;
  if (input.actor.trim().toLowerCase() === TASK_ASSIGNEES.human) return input.assignee;
  if (hasNonAutonomousTaskLabel(input.labels)) return input.assignee;

  return TASK_ASSIGNEES.dispatcher;
}
