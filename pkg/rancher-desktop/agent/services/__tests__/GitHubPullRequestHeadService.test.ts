import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

interface PullsGetArgs { owner: string; repo: string; pull_number: number }
const pullsGet = jest.fn<(args: PullsGetArgs) => Promise<unknown>>();

jest.unstable_mockModule('../IntegrationService', () => ({
  getIntegrationService: () => ({ getIntegrationValue: () => Promise.resolve({ value: 'token' }) }),
}));
jest.unstable_mockModule('@octokit/rest', () => ({
  Octokit: jest.fn(() => ({ pulls: { get: pullsGet } })),
}));

let extractPullRequestReference: (
  githubIssue: string | null,
  comments: { body: string }[],
) => { owner: string; repo: string; pullNumber: number } | null;
let extractPullRequestReferences: (
  githubIssue: string | null,
  comments: { body: string }[],
) => { owner: string; repo: string; pullNumber: number }[];
let resolvePullRequestHeads: (
  githubIssue: string | null,
  comments: { body: string }[],
) => Promise<{ owner: string; repo: string; pullNumber: number; sha: string }[]>;

beforeAll(async() => {
  ({ extractPullRequestReference, extractPullRequestReferences, resolvePullRequestHeads } = await import('../GitHubPullRequestHeadService'));
});

beforeEach(() => {
  pullsGet.mockReset();
});

function notFound(): Error {
  return Object.assign(new Error('Not Found - https://docs.github.com/rest/pulls/pulls#get-a-pull-request'), { status: 404 });
}

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

  it('ignores markdown around an owner/repo reference in an artifact receipt', () => {
    const receipt = { body: '- code_pr `dataripple-org/ripple-receptionist-worker#2735` (`7cd5369`) — https://github.com/dataripple-org/ripple-receptionist-worker/pull/2735. Repair pushed to PR #2735.' };
    const evidence = { body: 'Attached evidence (code_pr dataripple-org/ripple-receptionist-worker#2735 @ 585b6ffd).' };
    const expected = { owner: 'dataripple-org', repo: 'ripple-receptionist-worker', pullNumber: 2735 };

    expect(extractPullRequestReferences(null, [receipt, evidence])).toEqual([expected]);
    expect(extractPullRequestReference(null, [{ body: 'code_pr `dataripple-org/ripple-receptionist-worker#2735`. Repaired on PR #2735.' }])).toEqual(expected);
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

  it('does not carry one comment\'s repository into a later comment\'s bare PR number', () => {
    // suN1, 2026-10-01: a comment about Sulla Desktop's PR #911 was bound to
    // audio-driver, and the review died on audio-driver#911 (404).
    expect(extractPullRequestReferences(null, [
      { body: 'Repair pushed to https://github.com/dataripple-org/audio-driver/pull/1' },
      { body: 'Lane agents get full context after PR #911 merges.' },
    ])).toEqual([{ owner: 'dataripple-org', repo: 'audio-driver', pullNumber: 1 }]);
  });

  it('binds a bare PR number to the nearest repository named before it', () => {
    // Rdm0, 2026-10-01: "PR #2749" was bound to the last repo in the comment
    // (audio-driver) instead of the one it followed.
    expect(extractPullRequestReferences(null, [{
      body: 'Server https://github.com/dataripple-org/ripple-receptionist-worker/pull/2749 then PR #2749 CI. ' +
        'Desktop https://github.com/dataripple-org/audio-driver/pull/3 after PR #2.',
    }])).toEqual([
      { owner: 'dataripple-org', repo: 'ripple-receptionist-worker', pullNumber: 2749 },
      { owner: 'dataripple-org', repo: 'audio-driver', pullNumber: 3 },
      { owner: 'dataripple-org', repo: 'audio-driver', pullNumber: 2 },
    ]);
  });

  it('drops an inferred PR that 404s or is not open, but keeps explicit URLs', async() => {
    pullsGet.mockImplementation((args) => {
      const pullNumber = args.pull_number;

      if (args.repo === 'sulla-desktop' && pullNumber === 671) return Promise.resolve({ data: { state: 'open', head: { sha: 'AAA' } } });
      if (pullNumber === 12) return Promise.resolve({ data: { state: 'closed', head: { sha: 'bbb' } } });

      return Promise.reject(notFound());
    });

    await expect(resolvePullRequestHeads('merchantprotocol/sulla-desktop#669', [
      { body: 'Code at https://github.com/merchantprotocol/sulla-desktop/pull/671' },
      { body: 'Old PR #12 merged; stray PR #404 mention.' },
    ])).resolves.toEqual([
      { owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 671, sha: 'aaa' },
    ]);
  });

  it('still fails when an explicit PR URL cannot be resolved', async() => {
    pullsGet.mockImplementation(() => Promise.reject(notFound()));

    await expect(resolvePullRequestHeads(null, [
      { body: 'Code at https://github.com/merchantprotocol/sulla-desktop/pull/999' },
    ])).rejects.toThrow('Not Found');
  });
});
