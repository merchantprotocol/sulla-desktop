import { DomainError } from '../errors';

export class EpicId {
  private constructor(public readonly value: string) {
    Object.freeze(this);
  }

  static of(raw: unknown): EpicId {
    if (typeof raw !== 'string' || raw.trim().length === 0 || raw.trim().length > 128) {
      throw new DomainError(`Invalid EpicId: ${ JSON.stringify(raw) }`);
    }
    return new EpicId(raw.trim());
  }

  equals(other: EpicId | null | undefined): boolean {
    return other instanceof EpicId && other.value === this.value;
  }

  toString(): string {
    return this.value;
  }
}
