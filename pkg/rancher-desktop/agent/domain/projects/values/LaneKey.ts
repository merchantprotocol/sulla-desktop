import { DomainError } from '../errors';

/**
 * Stable, immutable key of a Projects lane (column). Mirrors WorkLaneDefinitionModel
 * lane_key semantics: immutable after creation, drawn from a fixed system set plus
 * project-defined custom keys.
 */
export class LaneKey {
  /** Canonical system lane keys (WorkLaneDefinitionModel default lane set, in order). */
  static readonly SYSTEM = Object.freeze([
    'backlog', 'todo', 'planning', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled', 'parked',
  ] as const);

  private static readonly PATTERN = /^[a-z][a-z0-9_]*$/;

  private constructor(public readonly value: string) {
    Object.freeze(this);
  }

  static of(raw: unknown): LaneKey {
    const key = LaneKey.normalize(raw);
    if (key === null) {
      throw new DomainError(`Invalid LaneKey: ${JSON.stringify(raw)}`);
    }
    return new LaneKey(key);
  }

  static tryOf(raw: unknown): LaneKey | null {
    const key = LaneKey.normalize(raw);
    return key === null ? null : new LaneKey(key);
  }

  static isValid(raw: unknown): boolean {
    return LaneKey.normalize(raw) !== null;
  }

  private static normalize(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (trimmed.length > 64 || !LaneKey.PATTERN.test(trimmed)) return null;
    return trimmed;
  }

  isSystem(): boolean {
    return (LaneKey.SYSTEM as readonly string[]).includes(this.value);
  }

  equals(other: LaneKey | null | undefined): boolean {
    return other instanceof LaneKey && other.value === this.value;
  }

  toString(): string {
    return this.value;
  }
}
