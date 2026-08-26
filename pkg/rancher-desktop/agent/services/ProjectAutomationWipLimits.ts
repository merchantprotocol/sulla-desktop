import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import type { WorkLaneSemanticRole } from '../database/models/WorkLaneDefinitionModel';

/**
 * Semantic-stage-aware Work-In-Progress limits and downstream backpressure.
 *
 * Issue #711 generalises the single "drain review before todo" invariant from
 * #709 into a configurable, per-semantic-role WIP ceiling with downstream-first
 * precedence. The durable settings live as additive keys on the existing
 * {@link SullaSettingsModel}; issue #706 remains the umbrella owner of the
 * Project Automation settings UI and the shared advisory-lock claim wrapper.
 * These keys never introduce a second settings store, and every default is
 * inherited from #706's per-kind concurrency keys when present so the two
 * compose cleanly.
 */

export type WipLimits = Record<WorkLaneSemanticRole, number | null>;
export type RoleCounts = Partial<Record<WorkLaneSemanticRole, number>>;

/** Every semantic role the dispatcher can resolve a task into. */
export const ALL_SEMANTIC_ROLES: readonly WorkLaneSemanticRole[] =
  ['backlog', 'planning', 'execution', 'review', 'blocked', 'terminal', 'manual'] as const;

/**
 * Drain priority, most-downstream stage first. A claim for an upstream role is
 * held while any strictly-more-downstream role is at or over its ceiling.
 * Mirrors #711: terminal handoff and review before repair (blocked recovery),
 * repair before execution, execution before todo intake.
 */
export const DRAIN_PRIORITY: readonly WorkLaneSemanticRole[] =
  ['terminal', 'review', 'blocked', 'execution', 'planning', 'backlog'] as const;

/** Documented safe range for a durable WIP ceiling (see #706). */
export const WIP_MIN = 1;
export const WIP_MAX = 20;

const SETTING_PREFIX = 'projectAutomation.wip.';

/**
 * Compose-friendly defaults: where #706 has persisted a per-kind concurrency
 * ceiling we inherit it; otherwise a conservative constant. Roles absent here
 * (backlog, terminal, manual) carry no ceiling by default.
 */
const DEFAULT_SOURCE: Partial<Record<WorkLaneSemanticRole, { key: string; fallback: number }>> = {
  execution: { key: 'routineConcurrency_execution', fallback: 3 },
  review:    { key: 'routineConcurrency_review',    fallback: 3 },
  planning:  { key: 'routineConcurrency_planning',  fallback: 2 },
  blocked:   { key: 'routineConcurrency_repair',    fallback: 2 },
  manual:    { key: 'routineConcurrency_other',     fallback: 2 },
};

/**
 * Coerce a durable setting into an integer ceiling. Non-numeric, zero, or
 * negative values mean "no ceiling" (unlimited); positive values clamp to the
 * documented [WIP_MIN, WIP_MAX] range.
 */
export function clampWipLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(WIP_MAX, Math.max(WIP_MIN, n));
}

async function readRoleLimit(role: WorkLaneSemanticRole): Promise<number | null> {
  const explicit = await SullaSettingsModel.get(SETTING_PREFIX + role, null);
  if (explicit !== null && explicit !== undefined && explicit !== '') {
    return clampWipLimit(explicit);
  }
  const src = DEFAULT_SOURCE[role];
  if (!src) return null;
  const inherited = await SullaSettingsModel.get(src.key, null);
  if (inherited !== null && inherited !== undefined && inherited !== '') {
    return clampWipLimit(inherited);
  }
  return clampWipLimit(src.fallback);
}

/** Resolve the effective per-role ceilings from durable settings. */
export async function resolveWipLimits(): Promise<WipLimits> {
  const out = {} as WipLimits;
  const enabled = Boolean(await SullaSettingsModel.get('automatedProjectManagementEnabled', true));
  if (!enabled) {
    for (const role of ALL_SEMANTIC_ROLES) out[role] = null;
    return out;
  }
  for (const role of ALL_SEMANTIC_ROLES) out[role] = await readRoleLimit(role);
  return out;
}

/** Persist an explicit per-role ceiling. Null / <=0 stores "unlimited". */
export async function setWipLimit(role: WorkLaneSemanticRole, value: number | null): Promise<void> {
  await SullaSettingsModel.set(SETTING_PREFIX + role, clampWipLimit(value) ?? 0, 'number');
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
