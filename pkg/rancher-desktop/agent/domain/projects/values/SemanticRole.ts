import { DomainError } from '../errors';

/** The semantic role vocabulary — faithful port of WorkLaneSemanticRole. */
export type SemanticRoleValue =
  | 'backlog' | 'planning' | 'execution' | 'review' | 'blocked' | 'terminal' | 'manual';

/**
 * Semantic role of a lane — the stage-independent meaning that drives routine/workflow
 * selection. Ports WorkLaneDefinitionModel's WorkLaneSemanticRole together with its
 * REQUIRED_WORK_LANE_ROLES and COMPATIBILITY_ROLE_BY_KEY constants.
 */
export class SemanticRole {
  static readonly BACKLOG = new SemanticRole('backlog');
  static readonly PLANNING = new SemanticRole('planning');
  static readonly EXECUTION = new SemanticRole('execution');
  static readonly REVIEW = new SemanticRole('review');
  static readonly BLOCKED = new SemanticRole('blocked');
  static readonly TERMINAL = new SemanticRole('terminal');
  static readonly MANUAL = new SemanticRole('manual');

  /** All roles, canonical order. */
  static readonly ALL: readonly SemanticRole[] = Object.freeze([
    SemanticRole.BACKLOG, SemanticRole.PLANNING, SemanticRole.EXECUTION,
    SemanticRole.REVIEW, SemanticRole.BLOCKED, SemanticRole.TERMINAL, SemanticRole.MANUAL,
  ]);

  /** Roles a runtime lane catalog must provide (mirrors REQUIRED_WORK_LANE_ROLES; manual excluded). */
  static readonly REQUIRED: readonly SemanticRoleValue[] = Object.freeze([
    'backlog', 'execution', 'planning', 'review', 'blocked', 'terminal',
  ]);

  /** Compatibility mapping from a known lane key to its semantic role (COMPATIBILITY_ROLE_BY_KEY). */
  private static readonly ROLE_BY_KEY: Readonly<Record<string, SemanticRoleValue>> = Object.freeze({
    backlog: 'backlog',
    planning: 'planning',
    todo: 'execution',
    in_progress: 'execution',
    in_review: 'review',
    blocked: 'blocked',
    done: 'terminal',
    cancelled: 'terminal',
    parked: 'manual',
  });

  private constructor(public readonly value: SemanticRoleValue) {
    Object.freeze(this);
  }

  static of(raw: unknown): SemanticRole {
    const role = SemanticRole.tryOf(raw);
    if (role === null) {
      throw new DomainError(`Invalid SemanticRole: ${JSON.stringify(raw)}`);
    }
    return role;
  }

  static tryOf(raw: unknown): SemanticRole | null {
    if (raw instanceof SemanticRole) return raw;
    if (typeof raw !== 'string') return null;
    return SemanticRole.ALL.find(r => r.value === raw) ?? null;
  }

  /** Resolve the compatibility role for a known lane key, or null if unmapped. */
  static forLaneKey(laneKey: unknown): SemanticRole | null {
    if (typeof laneKey !== 'string') return null;
    const mapped = SemanticRole.ROLE_BY_KEY[laneKey];
    return mapped ? SemanticRole.of(mapped) : null;
  }

  isRequired(): boolean {
    return SemanticRole.REQUIRED.includes(this.value);
  }

  isTerminal(): boolean {
    return this.value === 'terminal';
  }

  equals(other: SemanticRole | null | undefined): boolean {
    return other instanceof SemanticRole && other.value === this.value;
  }

  toString(): string {
    return this.value;
  }
}
