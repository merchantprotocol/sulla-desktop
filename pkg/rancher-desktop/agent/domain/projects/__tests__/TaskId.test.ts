import { TaskId } from '../values/TaskId';
import { DomainError } from '../errors';

describe('TaskId', () => {
  it('accepts a valid slug id and exposes its value', () => {
    expect(TaskId.of('YceX').value).toBe('YceX');
  });
  it('trims surrounding whitespace', () => {
    expect(TaskId.of('  YceX  ').value).toBe('YceX');
  });
  it('rejects empty / non-string / oversized ids', () => {
    expect(() => TaskId.of('')).toThrow(DomainError);
    expect(() => TaskId.of('   ')).toThrow(DomainError);
    expect(() => TaskId.of(123 as unknown)).toThrow(DomainError);
    expect(() => TaskId.of(null)).toThrow(DomainError);
    expect(() => TaskId.of('x'.repeat(129))).toThrow(DomainError);
  });
  it('tryOf returns null instead of throwing; isValid reflects it', () => {
    expect(TaskId.tryOf('')).toBeNull();
    expect(TaskId.tryOf('YceX')).not.toBeNull();
    expect(TaskId.isValid('YceX')).toBe(true);
    expect(TaskId.isValid('')).toBe(false);
  });
  it('has value equality', () => {
    expect(TaskId.of('a').equals(TaskId.of('a'))).toBe(true);
    expect(TaskId.of('a').equals(TaskId.of('b'))).toBe(false);
    expect(TaskId.of('a').equals(null)).toBe(false);
  });
  it('is immutable and stringifies to its value', () => {
    const id = TaskId.of('abc');
    expect(Object.isFrozen(id)).toBe(true);
    expect(String(id)).toBe('abc');
  });
});
