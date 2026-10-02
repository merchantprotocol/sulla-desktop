import { Octokit } from '@octokit/rest';

import { getIntegrationService } from './IntegrationService';

// Owner/repo limited to GitHub's name characters, so markdown around a
// reference (e.g. a receipt's `owner/repo#12`) never leaks into the owner.
const PULL_URL_PATTERN = /github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/gi;
const REPOSITORY_REFERENCE_PATTERN = /(?:github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#\d+/i;

export interface GitHubPullRequestReference {
  owner:      string;
  repo:       string;
  pullNumber: number;
}

export interface GitHubPullRequestHead extends GitHubPullRequestReference {
  sha: string;
}

interface ScannedReference extends GitHubPullRequestReference {
  // True for a full pull-request URL. A bare "PR #N" is only inferred: its
  // repository comes from context, so it may name a PR that does not exist.
  explicit: boolean;
}

const TOKEN_PATTERN = new RegExp(
  `${ PULL_URL_PATTERN.source }|${ REPOSITORY_REFERENCE_PATTERN.source }|\\b(?:draft\\s+)?PR\\s*#(\\d+)\\b`,
  'gi',
);

/**
 * Walk the task history in order. A bare "PR #N" binds to the nearest
 * repository named earlier in the same text, else to the task's own
 * repository. Repository context never carries across comments: one comment
 * naming another repo's PR must not rebind a later comment's "PR #911".
 */
function scanReferences(githubIssue: string | null, comments: { body: string }[]): ScannedReference[] {
  const taskRepoMatch = REPOSITORY_REFERENCE_PATTERN.exec(githubIssue || '');
  const taskRepository = taskRepoMatch ? { owner: taskRepoMatch[1], repo: taskRepoMatch[2] } : null;
  const found: ScannedReference[] = [];

  for (const text of [githubIssue || '', ...comments.map(comment => comment.body)]) {
    let repository = taskRepository;
    for (const match of text.matchAll(TOKEN_PATTERN)) {
      if (match[1]) {
        repository = { owner: match[1], repo: match[2] };
        found.push({ ...repository, pullNumber: Number(match[3]), explicit: true });
      } else if (match[4]) {
        repository = { owner: match[4], repo: match[5] };
      } else if (match[6] && repository) {
        found.push({ ...repository, pullNumber: Number(match[6]), explicit: false });
      }
    }
  }
  return found;
}

function referenceKey(reference: GitHubPullRequestReference): string {
  return `${ reference.owner.toLowerCase() }/${ reference.repo.toLowerCase() }#${ reference.pullNumber }`;
}

function strip({ owner, repo, pullNumber }: GitHubPullRequestReference): GitHubPullRequestReference {
  return { owner, repo, pullNumber };
}

export function extractPullRequestReference(
  githubIssue: string | null,
  comments: { body: string }[],
): GitHubPullRequestReference | null {
  const found = scanReferences(githubIssue, comments);
  return found.length > 0 ? strip(found[found.length - 1]) : null;
}

function distinctReferences(githubIssue: string | null, comments: { body: string }[]): ScannedReference[] {
  const references = new Map<string, ScannedReference>();
  for (const reference of scanReferences(githubIssue, comments)) {
    const key = referenceKey(reference);
    const existing = references.get(key);
    // A URL anywhere in history makes the reference explicit.
    references.set(key, { ...reference, explicit: reference.explicit || existing?.explicit === true });
  }
  return [...references.values()];
}

/** Return every distinct PR mentioned by custody evidence, in evidence order. */
export function extractPullRequestReferences(
  githubIssue: string | null,
  comments: { body: string }[],
): GitHubPullRequestReference[] {
  return distinctReferences(githubIssue, comments).map(strip);
}

async function client(): Promise<Octokit> {
  const token = await getIntegrationService().getIntegrationValue('github', 'token');
  if (!token) throw new Error('github_token_unavailable');
  return new Octokit({ auth: token.value });
}

export async function resolvePullRequestHead(
  githubIssue: string | null,
  comments: { body: string }[],
): Promise<GitHubPullRequestHead | null> {
  const reference = extractPullRequestReference(githubIssue, comments);
  if (!reference) return null;

  const octokit = await client();
  const { data } = await octokit.pulls.get({
    owner:       reference.owner,
    repo:        reference.repo,
    pull_number: reference.pullNumber,
  });
  return { ...reference, sha: data.head.sha.toLowerCase() };
}

/**
 * Resolve every PR in the task history. A full URL must resolve or the whole
 * call fails. An inferred bare "PR #N" that 404s or is not open is dropped:
 * it is a guess about which repo the number belongs to, and one wrong guess
 * must not abort the review generation.
 */
export async function resolvePullRequestHeads(
  githubIssue: string | null,
  comments: { body: string }[],
): Promise<GitHubPullRequestHead[]> {
  const references = distinctReferences(githubIssue, comments);
  if (references.length === 0) return [];
  const octokit = await client();
  const heads = await Promise.all(references.map(async(reference): Promise<GitHubPullRequestHead | null> => {
    try {
      const { data } = await octokit.pulls.get({
        owner: reference.owner, repo: reference.repo, pull_number: reference.pullNumber,
      });
      if (!reference.explicit && data.state !== 'open') return null;
      return { ...strip(reference), sha: data.head.sha.toLowerCase() };
    } catch (err: any) {
      if (!reference.explicit && err?.status === 404) return null;
      throw err;
    }
  }));
  return heads.filter((head): head is GitHubPullRequestHead => head !== null);
}
