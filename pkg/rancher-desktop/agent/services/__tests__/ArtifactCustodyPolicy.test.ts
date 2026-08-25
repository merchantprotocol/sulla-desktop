import { ArtifactCustodyPolicy } from '../ArtifactCustodyPolicy';

describe('ArtifactCustodyPolicy.validate', () => {
  it('accepts missing custody — it is optional', () => {
    expect(ArtifactCustodyPolicy.validate(null).ok).toBe(true);
    expect(ArtifactCustodyPolicy.validate(undefined).ok).toBe(true);
  });

  it('accepts a partial code-shaped custody object without requiring every field', () => {
    const result = ArtifactCustodyPolicy.validate({ workKind: 'code', branch: 'b', commitSha: 'c' } as any);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('accepts a bare non_code custody object with no other fields', () => {
    expect(ArtifactCustodyPolicy.validate({ workKind: 'non_code' } as any).ok).toBe(true);
  });

  it('accepts custody with no workKind at all — a couple of generic optional fields is enough', () => {
    expect(ArtifactCustodyPolicy.validate({ artifactUrl: 'https://a' } as any).ok).toBe(true);
  });

  it('rejects a structurally malformed custody payload (not an object)', () => {
    expect(ArtifactCustodyPolicy.validate('nonsense' as any).ok).toBe(false);
    expect(ArtifactCustodyPolicy.validate(['a', 'b'] as any).ok).toBe(false);
  });
});

describe('ArtifactCustodyPolicy.assertForTransition', () => {
  it('never throws — custody is optional, not a gate', async() => {
    await expect(ArtifactCustodyPolicy.assertForTransition('in_review', null)).resolves.toBeUndefined();
    await expect(ArtifactCustodyPolicy.assertForTransition('done', undefined)).resolves.toBeUndefined();
    await expect(ArtifactCustodyPolicy.assertForTransition('done', { workKind: 'code' })).resolves.toBeUndefined();
  });
});

describe('ArtifactCustodyPolicy.derive', () => {
  it('maps code artifact fields to code custody', () => {
    const custody = ArtifactCustodyPolicy.derive({
      artifactType: 'code_pull_request', artifactUrl: 'https://pr', artifactRef: 'sha1', contentHash: 'c1',
    });
    expect(custody?.workKind).toBe('code');
    expect(custody?.prUrl).toBe('https://pr');
    expect(custody?.commitSha).toBe('c1');
  });

  it('returns null when there is nothing to derive from', () => {
    expect(ArtifactCustodyPolicy.derive(null)).toBeNull();
    expect(ArtifactCustodyPolicy.derive({})).toBeNull();
  });
});

describe('ArtifactCustodyPolicy.persistWithClient', () => {
  it('defaults work_kind to non_code when custody omits workKind, to satisfy the NOT NULL column', async() => {
    const query = jest.fn().mockResolvedValue({});
    const client = { query } as any;
    await ArtifactCustodyPolicy.persistWithClient(client, 'task-1', 'in_review', { artifactUrl: 'https://a' }, 'sulla');
    expect(query).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['task-1', 'in_review', 'non_code']),
    );
  });
});
