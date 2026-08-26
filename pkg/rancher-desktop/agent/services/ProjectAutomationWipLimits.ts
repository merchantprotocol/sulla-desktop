import type { WorkLaneSemanticRole } from '../database/models/WorkLaneDefinitionModel';

/**
 * Semantic-stage WIP evaluation primitives.
 *
 * Per-swimlane WIP ceilings (issue #711) were removed at Jonathon's explicit
 * direction (2026-08-25): the Project Automation settings surface exposes
 * exactly one concurrency knob (the total concurrent-agent limit in
 * {@link RoutineConcurrencyPolicy}), not per-stage caps. resolveWipLimits()
 * therefore always resolves "no ceiling" for every role, so evaluateClaim()
 * never holds a claim on WIP grounds. The pure evaluateClaim()/clampWipLimit()
 * primitives are kept because TaskDispatcherService, WorkTaskDispatchModel,
 * ProjectsApplicationService, and conveyor_health still call through this
 * module's shape; they now always observe an always-allowed decision.
 */

export type WipLimits = Record<WorkLaneSemanticRole, number | null>;
export type RoleCounts = Partial<Record<WorkLaneSemanticRole, number>>;

/** Every semantic role the dispatcher can resolve a task into. */
export const ALL_SEMANTIC_ROLES: readonly WorkLaneSemanticRole[] =
  ['backlog', 'planning', 'execution', 'review', 'blocked', 'terminal', 'manual'] as const;

/**
 * Drain priority, most-downstream stage first. Kept for evaluateClaim()'s
 * downstream-first precedence logic, which is inert while every limit is null.
 */
export const DRAIN_PRIORITY: readonly WorkLaneSemanticRole[] =
  ['terminal', 'review', 'blocked', 'execution', 'planning', 'backlog'] as const;

/** Documented safe range for a WIP ceiling, retained for clampWipLimit(). */
export const WIP_MIN = 1;
export const WIP_MAX = 20;

/**
 * Coerce a value into an integer ceiling. Non-numeric, zero, or negative
 * values mean "no ceiling" (unlimited); positive values clamp to the
 * documented [WIP_MIN, WIP_MAX] range.
 */
export function clampWipLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(WIP_MAX, Math.max(WIP_MIN, n));
}

/** Always unlimited -- per-swimlane WIP ceilings were removed. */
export async function resolveWipLimits(): Promise<WipLimits> {
  const out = {} as WipLimits;
  for (const role of ALL_SEMANTIC_ROLES) out[role] = null;
  return out;
}

export interface BackpressureDecision {
  allowed:    boolean;
  role:       WorkLaneSemanticRole;
  /** The stage holding the claim: the role itself (own ceiling) or a downstream role. */
  owningRole: WorkLaneSemanticRole | null;
  limit:      number | null;
  count:      number;
  reason:     string | null;
}

/**
 * Decide whether a fresh claim for {@link role} may proceed given current
 * per-role {@link counts} and configured {@link limits}. Pure and synchronous
 * so it is exhaustively unit-testable and can be evaluated inside a claim
 * transaction. A claim is held when the role is at its own ceiling, or when any
 * strictly-more-downstream role is saturated (downstream-first precedence).
 */
export function evaluateClaim(
  role: WorkLaneSemanticRole,
  counts: RoleCounts,
  limits: WipLimits,
): BackpressureDecision {
  const countOf = (r: WorkLaneSemanticRole) => Math.max(0, counts[r] ?? 0);

  const ownLimit = limits[role] ?? null;
  if (ownLimit !== null && countOf(role) >= ownLimit) {
    return {
      allowed: false, role, owningRole: role, limit: ownLimit, count: countOf(role),
      reason: `${role} stage is at its WIP limit (${countOf(role)}/${ownLimit})`,
    };
  }

  const myRank = DRAIN_PRIORITY.indexOf(role);
  for (let i = 0; i < DRAIN_PRIORITY.length; i++) {
    const downstream = DRAIN_PRIORITY[i];
    if (downstream === role) continue;
    const isMoreDownstream = myRank < 0 ? true : i < myRank;
    if (!isMoreDownstream) continue;
    const limit = limits[downstream] ?? null;
    if (limit !== null && countOf(downstream) >= limit) {
      return {
        allowed: false, role, owningRole: downstream, limit, count: countOf(downstream),
        reason: `downstream ${downstream} stage is saturated (${countOf(downstream)}/${limit}); draining it before new ${role} work`,
      };
    }
  }

  return { allowed: true, role, owningRole: null, limit: ownLimit, count: countOf(role), reason: null };
}
