import { beforeAll, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../IntegrationService', () => ({
  getIntegrationService: jest.fn(),
}));

let extractPullRequestReference: (
  githubIssue: string | null,
  comments: { body: string }[],
) => { owner: string; repo: string; pullNumber: number } | null;
let extractPullRequestReferences: (
  githubIssue: string | null,
  comments: { body: string }[],
) => { owner: string; repo: string; pullNumber: number }[];

beforeAll(async() => {
  ({ extractPullRequestReference, extractPullRequestReferences } = await import('../GitHubPullRequestHeadService'));
});

describe('GitHubPullRequestHeadService', () => {
  it('prefers the latest concrete pull request URL in task history', () => {
    expect(extractPullRequestReference('merchantprotocol/sulla-desktop#660', [
      { body: 'Draft PR https://github.com/merchantprotocol/sulla-desktop/pull/665 at the first head.' },
      { body: 'Replacement PR https://github.com/merchantprotocol/sulla-desktop/pull/667 is ready.' },
    ])).toEqual({ owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 667 });
  });

  it('resolves a short PR number against the task repository', () => {
    expect(extractPullRequestReference('merchantprotocol/sulla-desktop#660', [
      { body: 'Shipped to draft PR #665.' },
    ])).toEqual({ owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 665 });
  });

  it('does not mistake the linked issue itself for a pull request', () => {
    expect(extractPullRequestReference('merchantprotocol/sulla-desktop#660', [])).toBeNull();
  });

  it('keeps every distinct code component of a mixed handoff for exact-head checks', () => {
    expect(extractPullRequestReferences('merchantprotocol/sulla-desktop#669', [
      { body: 'Component A https://github.com/merchantprotocol/sulla-desktop/pull/671' },
      { body: 'Component B https://github.com/merchantprotocol/sulla-cloud/pull/88 and duplicate PR #88' },
    ])).toEqual([
      { owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 671 },
      { owner: 'merchantprotocol', repo: 'sulla-cloud', pullNumber: 88 },
    ]);
  });
});
