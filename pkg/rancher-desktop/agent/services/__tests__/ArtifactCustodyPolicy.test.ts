const settingsGet = jest.fn();

jest.mock('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: (...args: any[]) => settingsGet(...args) },
}));

import { ArtifactCustodyPolicy, ArtifactCustodyError } from '../ArtifactCustodyPolicy';

describe('ArtifactCustodyPolicy.validate', () => {
  it('rejects missing custody', () => {
    expect(ArtifactCustodyPolicy.validate(null).ok).toBe(false);
    expect(ArtifactCustodyPolicy.validate(undefined).missing).toContain('workKind');
  });

  it('requires the full code custody set', () => {
    const result = ArtifactCustodyPolicy.validate({ workKind: 'code', branch: 'b', commitSha: 'c' } as any);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining(['prUrl', 'prHeadSha', 'validation', 'provenance']));
  });

  it('accepts complete code custody', () => {
    const result = ArtifactCustodyPolicy.validate({
      workKind: 'code', branch: 'feat/x', commitSha: 'abc', prUrl: 'https://pr', prHeadSha: 'def',
      validation: { tests: 'pass' }, provenance: { agent: 'a' },
    });
    expect(result.ok).toBe(true);
  });

  it('requires artifact id/url plus evidence and provenance for non_code', () => {
    expect(ArtifactCustodyPolicy.validate({ workKind: 'non_code' } as any).ok).toBe(false);
    expect(ArtifactCustodyPolicy.validate({
      workKind: 'non_code', artifactUrl: 'https://a', evidence: { x: 1 }, provenance: { a: 1 },
    }).ok).toBe(true);
  });
});

describe('ArtifactCustodyPolicy.assertForTransition', () => {
  beforeEach(() => settingsGet.mockReset());

  it('cannot be disabled by the retired preference', async() => {
    settingsGet.mockResolvedValue(false);
    await expect(ArtifactCustodyPolicy.assertForTransition('in_review', null)).rejects.toBeInstanceOf(ArtifactCustodyError);
  });

  it('throws when enforced and custody is missing', async() => {
    settingsGet.mockResolvedValue(true);
    await expect(ArtifactCustodyPolicy.assertForTransition('done', null)).rejects.toBeInstanceOf(ArtifactCustodyError);
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
});
