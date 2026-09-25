import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const merge = jest.fn<(...args: any[]) => Promise<any>>();
const list = jest.fn<(...args: any[]) => Promise<any>>();
const getIntegrationValue = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('@octokit/rest', () => ({
  Octokit: class { pulls = { merge, list }; },
}));
jest.unstable_mockModule('../../../services/IntegrationService', () => ({
  getIntegrationService: () => ({ getIntegrationValue }),
}));
jest.unstable_mockModule('../../base', () => ({ BaseTool: class {} }));

const { GitHubMergePRWorker } = await import('../github_merge_pr');
const { GitHubListPRsWorker } = await import('../github_list_prs');
const testedSha = 'a'.repeat(40);
const mergeInput = { owner: 'org', repo: 'repo', pull_number: 7, confirm: true, sha: testedSha };
const callMerge = (input: any) => (new GitHubMergePRWorker() as any)._validatedCall(input);
const callList = (input: any) => (new GitHubListPRsWorker() as any)._validatedCall(input);

beforeEach(() => {
  jest.clearAllMocks();
  getIntegrationValue.mockResolvedValue({ value: 'test-only-token' });
});

describe('tested PR head merge contract', () => {
  it('pins the reviewed head in the GitHub mutation', async() => {
    merge.mockResolvedValue({ data: { merged: true, sha: 'b'.repeat(40), message: 'merged' } });
    await expect(callMerge(mergeInput)).resolves.toMatchObject({ successBoolean: true });
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ sha: testedSha, pull_number: 7 }));
  });

  it('reports a head mismatch as failure without an unpinned retry', async() => {
    merge.mockRejectedValue({ response: { status: 409, data: { message: 'Head changed' } } });
    await expect(callMerge(mergeInput)).resolves.toMatchObject({ successBoolean: false, responseString: 'Merge failed: Head changed' });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('does not call a successful HTTP response a merge when merged is false', async() => {
    merge.mockResolvedValue({ data: { merged: false, message: 'Branch protection rejected merge' } });
    await expect(callMerge(mergeInput)).resolves.toMatchObject({ successBoolean: false });
  });

  it.each(['', 'abc', 'z'.repeat(40), null])('rejects invalid supplied SHA %p before requesting credentials', async(sha) => {
    await expect(callMerge({ ...mergeInput, sha })).resolves.toMatchObject({ successBoolean: false });
    expect(getIntegrationValue).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });

  it('retains the explicit confirmation gate', async() => {
    await expect(callMerge({ ...mergeInput, confirm: false })).resolves.toMatchObject({ successBoolean: false });
    expect(merge).not.toHaveBeenCalled();
  });
});

describe('complete PR inventory pagination', () => {
  it('forwards page and filters and reports the next page even when fewer than the limit were returned', async() => {
    list.mockResolvedValue({ data: [{ number: 7, title: 'Draft work', draft: true, head: { ref: 'feature' }, base: { ref: 'main' }, state: 'open', updated_at: '2026-09-24' }], headers: { link: '<https://api.github.com/repos/org/repo/pulls?page=3>; rel="next"' } });
    const result = await callList({ owner: 'org', repo: 'repo', state: 'open', limit: 100, page: 2, sort: 'created' });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ state: 'open', per_page: 100, page: 2, sort: 'created' }));
    expect(result.responseString).toContain('page=3');
    expect(result.responseString).toContain('[draft]');
  });

  it('distinguishes an empty later page from an empty repository', async() => {
    list.mockResolvedValue({ data: [], headers: {} });
    const result = await callList({ owner: 'org', repo: 'repo', page: 3 });
    expect(result.responseString).toContain('on page 3');
    expect(result.responseString).toContain('No further pages.');
  });

  it.each([0, -1, 1.5, '2'])('rejects invalid page %p', async(page) => {
    await expect(callList({ owner: 'org', repo: 'repo', page })).resolves.toMatchObject({ successBoolean: false });
    expect(list).not.toHaveBeenCalled();
  });
});
