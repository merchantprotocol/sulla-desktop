export const TASK_ASSIGNEES = {
  dispatcher:  'dispatcher',
  heartbeat:   'heartbeat',
  human:       'human',
  legacySulla: 'sulla',
} as const;

export const AUTONOMOUS_TASK_ASSIGNEES = [
  TASK_ASSIGNEES.heartbeat,
  TASK_ASSIGNEES.dispatcher,
] as const;

export const AUTONOMOUS_TASK_ACTORS = [
  TASK_ASSIGNEES.legacySulla,
  TASK_ASSIGNEES.heartbeat,
  TASK_ASSIGNEES.dispatcher,
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
}

export function hasNonAutonomousTaskLabel(labels: readonly string[] | null): boolean {
  const denied = new Set<string>(NON_AUTONOMOUS_TASK_LABELS);

  return (labels ?? []).some(label => denied.has(label.trim().toLowerCase()));
}

/**
 * Keep task authorship separate from durable queue ownership. `sulla` is an
 * actor identity retained for attribution, not a mechanical queue assignee.
 */
export function normalizeAutonomousTaskOwnership(input: TaskOwnershipInput): string | null {
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
