import { SemanticRole } from '../values/SemanticRole';
import { DomainError } from '../errors';

describe('SemanticRole', () => {
  it('exposes the seven canonical roles in order', () => {
    expect(SemanticRole.ALL.map(r => r.value)).toEqual([
      'backlog', 'planning', 'execution', 'review', 'blocked', 'terminal', 'manual',
    ]);
  });
  it('REQUIRED mirrors REQUIRED_WORK_LANE_ROLES (manual excluded)', () => {
    expect([...SemanticRole.REQUIRED]).toEqual([
      'backlog', 'planning', 'execution', 'review', 'blocked', 'terminal',
    ]);
    expect(SemanticRole.MANUAL.isRequired()).toBe(false);
    for (const v of SemanticRole.REQUIRED) {
      expect(SemanticRole.of(v).isRequired()).toBe(true);
    }
  });
  it('forLaneKey reproduces COMPATIBILITY_ROLE_BY_KEY', () => {
    const expected: Record<string, string> = {
      backlog: 'backlog', planning: 'planning', todo: 'execution', in_progress: 'execution',
      in_review: 'review', blocked: 'blocked', done: 'terminal', cancelled: 'terminal', parked: 'manual',
    };
    for (const [key, role] of Object.entries(expected)) {
      expect(SemanticRole.forLaneKey(key)?.value).toBe(role);
    }
    expect(SemanticRole.forLaneKey('unknown_key')).toBeNull();
    expect(SemanticRole.forLaneKey(42)).toBeNull();
  });
  it('detects the terminal role', () => {
    expect(SemanticRole.TERMINAL.isTerminal()).toBe(true);
    expect(SemanticRole.EXECUTION.isTerminal()).toBe(false);
  });
  it('of() rejects unknown values; tryOf returns null; identity passthrough', () => {
    expect(() => SemanticRole.of('nope')).toThrow(DomainError);
    expect(SemanticRole.tryOf('nope')).toBeNull();
    expect(SemanticRole.tryOf(SemanticRole.REVIEW)).toBe(SemanticRole.REVIEW);
    expect(SemanticRole.REVIEW.equals(SemanticRole.of('review'))).toBe(true);
  });
});
