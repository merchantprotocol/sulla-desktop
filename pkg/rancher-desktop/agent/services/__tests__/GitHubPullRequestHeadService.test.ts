import { beforeAll, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../IntegrationService', () => ({
  getIntegrationService: jest.fn(),
}));

let extractPullRequestReference: (
  githubIssue: string | null,
  comments: { body: string }[],
) => { owner: string; repo: string; pullNumber: number } | null;

beforeAll(async() => {
  ({ extractPullRequestReference } = await import('../GitHubPullRequestHeadService'));
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
});
