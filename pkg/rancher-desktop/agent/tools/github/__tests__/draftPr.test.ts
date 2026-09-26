import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const get = jest.fn<(...args: any[]) => Promise<any>>();
const createComment = jest.fn<(...args: any[]) => Promise<any>>();
const graphql = jest.fn<(...args: any[]) => Promise<any>>();
const getIntegrationValue = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('@octokit/rest', () => ({
  Octokit: class {
    pulls = { get };
    issues = { createComment };
    graphql = graphql;
  },
}));
jest.unstable_mockModule('../../../services/IntegrationService', () => ({
  getIntegrationService: () => ({ getIntegrationValue }),
}));
jest.unstable_mockModule('../../base', () => ({ BaseTool: class {} }));

const { GitHubDraftPRWorker } = await import('../github_draft_pr');

const call = (input: any) => (new GitHubDraftPRWorker() as any)._validatedCall(input);
const input = { owner: 'org', repo: 'repo', pull_number: 7, comment: 'Vendor SMS credential is missing; add SMS_TOKEN then mark ready.' };
const openPr = { number: 7, title: 'Add vendor SMS', draft: false, merged: false, state: 'open', html_url: 'https://github.com/org/repo/pull/7', node_id: 'PR_kwNODE' };

beforeEach(() => {
  jest.clearAllMocks();
  getIntegrationValue.mockResolvedValue({ value: 'test-only-token' });
  get.mockResolvedValue({ data: { ...openPr } });
  createComment.mockResolvedValue({ data: { html_url: 'https://github.com/org/repo/pull/7#c1' } });
  graphql.mockResolvedValue({ convertPullRequestToDraft: { pullRequest: { number: 7, isDraft: true } } });
});

describe('returning a PR to draft', () => {
  it('posts the fix list and converts the PR to draft', async() => {
    await expect(call(input)).resolves.toMatchObject({ successBoolean: true });
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 7, body: input.comment }));
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('convertPullRequestToDraft'), { id: 'PR_kwNODE' });
  });

  it('posts the explanation before the PR leaves the ready queue', async() => {
    const order: string[] = [];

    createComment.mockImplementation(() => {
      order.push('comment');

      return Promise.resolve({ data: {} });
    });
    graphql.mockImplementation(() => {
      order.push('convert');

      return Promise.resolve({ convertPullRequestToDraft: { pullRequest: { isDraft: true } } });
    });
    await call(input);
    expect(order).toEqual(['comment', 'convert']);
  });

  it('refuses without a comment, before requesting credentials', async() => {
    for (const comment of ['', '   ', undefined, null, 42]) {
      await expect(call({ ...input, comment })).resolves.toMatchObject({ successBoolean: false });
    }
    expect(getIntegrationValue).not.toHaveBeenCalled();
    expect(graphql).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it.each([
    { owner: '' },
    { repo: '' },
    { pull_number: 0 },
    { pull_number: 'abc' },
  ])('rejects invalid identity %p without any GitHub call', async(patch) => {
    await expect(call({ ...input, ...patch })).resolves.toMatchObject({ successBoolean: false });
    expect(getIntegrationValue).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('refuses a merged PR without commenting or mutating', async() => {
    get.mockResolvedValue({ data: { ...openPr, merged: true, state: 'closed' } });
    await expect(call(input)).resolves.toMatchObject({ successBoolean: false });
    expect(createComment).not.toHaveBeenCalled();
    expect(graphql).not.toHaveBeenCalled();
  });

  it('refuses a closed PR without commenting or mutating', async() => {
    get.mockResolvedValue({ data: { ...openPr, state: 'closed' } });
    await expect(call(input)).resolves.toMatchObject({ successBoolean: false });
    expect(createComment).not.toHaveBeenCalled();
    expect(graphql).not.toHaveBeenCalled();
  });

  it('still records the reason on an already-draft PR without mutating', async() => {
    get.mockResolvedValue({ data: { ...openPr, draft: true } });
    await expect(call(input)).resolves.toMatchObject({ successBoolean: true });
    expect(createComment).toHaveBeenCalled();
    expect(graphql).not.toHaveBeenCalled();
  });

  it('does not report success when GitHub does not confirm the draft state', async() => {
    graphql.mockResolvedValue({ convertPullRequestToDraft: { pullRequest: { isDraft: false } } });
    await expect(call(input)).resolves.toMatchObject({ successBoolean: false });
  });

  it('does not report success on an empty mutation response', async() => {
    graphql.mockResolvedValue({});
    await expect(call(input)).resolves.toMatchObject({ successBoolean: false });
  });

  it('surfaces the GitHub error message on failure', async() => {
    graphql.mockRejectedValue({ response: { data: { message: 'Resource not accessible' } } });
    await expect(call(input)).resolves.toMatchObject({
      successBoolean: false, responseString: 'Draft PR failed: Resource not accessible',
    });
  });

  it('fails closed when the vault has no token', async() => {
    getIntegrationValue.mockResolvedValue(null);
    await expect(call(input)).resolves.toMatchObject({ successBoolean: false });
    expect(graphql).not.toHaveBeenCalled();
  });
});
