import { ArtifactGeneration } from '../values/ArtifactGeneration';
import { DomainError } from '../errors';

describe('ArtifactGeneration', () => {
  it('starts at generation 0 with no hash', () => {
    const g = ArtifactGeneration.initial();
    expect(g.generation).toBe(0);
    expect(g.hash).toBeNull();
  });
  it('rejects negative / non-integer / non-number generations', () => {
    expect(() => ArtifactGeneration.of(-1)).toThrow(DomainError);
    expect(() => ArtifactGeneration.of(1.5)).toThrow(DomainError);
    expect(() => ArtifactGeneration.of('2' as unknown)).toThrow(DomainError);
  });
  it('rejects a non-string hash', () => {
    expect(() => ArtifactGeneration.of(1, 5 as unknown)).toThrow(DomainError);
  });
  it('next() increments and clears the hash', () => {
    const g = ArtifactGeneration.of(3, 'abc').next();
    expect(g.generation).toBe(4);
    expect(g.hash).toBeNull();
  });
  it('withHash binds a non-empty content hash and rejects blank', () => {
    expect(ArtifactGeneration.of(1).withHash('deadbeef').hash).toBe('deadbeef');
    expect(() => ArtifactGeneration.of(1).withHash('   ')).toThrow(DomainError);
  });
  it('supersedes compares generation ordering', () => {
    expect(ArtifactGeneration.of(2).supersedes(ArtifactGeneration.of(1))).toBe(true);
    expect(ArtifactGeneration.of(1).supersedes(ArtifactGeneration.of(1))).toBe(false);
    expect(ArtifactGeneration.of(1).supersedes(ArtifactGeneration.of(2))).toBe(false);
  });
  it('sameArtifacts detects identical bound hashes only', () => {
    const a = ArtifactGeneration.of(1, 'h');
    const b = ArtifactGeneration.of(2, 'h');
    const c = ArtifactGeneration.of(3, 'other');
    expect(a.sameArtifacts(b)).toBe(true);
    expect(a.sameArtifacts(c)).toBe(false);
    expect(ArtifactGeneration.initial().sameArtifacts(ArtifactGeneration.initial())).toBe(false);
  });
  it('has value equality and immutability', () => {
    expect(ArtifactGeneration.of(1, 'h').equals(ArtifactGeneration.of(1, 'h'))).toBe(true);
    expect(ArtifactGeneration.of(1, 'h').equals(ArtifactGeneration.of(1, 'x'))).toBe(false);
    expect(ArtifactGeneration.of(1).equals(ArtifactGeneration.of(2))).toBe(false);
    expect(Object.isFrozen(ArtifactGeneration.initial())).toBe(true);
  });
});
