import { LaneKey } from '../values/LaneKey';
import { DomainError } from '../errors';

describe('LaneKey', () => {
  it('accepts valid keys', () => {
    expect(LaneKey.of('in_progress').value).toBe('in_progress');
    expect(LaneKey.of('  todo ').value).toBe('todo');
  });
  it('rejects invalid keys', () => {
    for (const bad of ['', 'In_Progress', '1abc', 'has space', '_leading', 'trailing-', 'a'.repeat(65)]) {
      expect(() => LaneKey.of(bad)).toThrow(DomainError);
    }
    expect(LaneKey.tryOf(42 as unknown)).toBeNull();
  });
  it('recognises exactly the nine default lane keys', () => {
    expect([...LaneKey.SYSTEM]).toEqual([
      'backlog', 'todo', 'planning', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled', 'parked',
    ]);
    for (const key of LaneKey.SYSTEM) {
      expect(LaneKey.of(key).isSystem()).toBe(true);
    }
    expect(LaneKey.of('custom_lane').isSystem()).toBe(false);
  });
  it('has value equality and is immutable', () => {
    expect(LaneKey.of('todo').equals(LaneKey.of('todo'))).toBe(true);
    expect(LaneKey.of('todo').equals(LaneKey.of('done'))).toBe(false);
    expect(Object.isFrozen(LaneKey.of('todo'))).toBe(true);
  });
});
