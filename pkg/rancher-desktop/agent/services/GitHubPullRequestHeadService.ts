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

export function extractPullRequestReference(
  githubIssue: string | null,
  comments: { body: string }[],
): GitHubPullRequestReference | null {
  const texts = [githubIssue || '', ...comments.map(comment => comment.body)];
  let repository: { owner: string; repo: string } | null = null;
  let reference: GitHubPullRequestReference | null = null;

  for (const text of texts) {
    for (const match of text.matchAll(PULL_URL_PATTERN)) {
      reference = { owner: match[1], repo: match[2], pullNumber: Number(match[3]) };
      repository = { owner: match[1], repo: match[2] };
    }
    const repositoryMatch = REPOSITORY_REFERENCE_PATTERN.exec(text);
    if (repositoryMatch) repository = { owner: repositoryMatch[1], repo: repositoryMatch[2] };
    const shortPullMatches = [...text.matchAll(/\b(?:draft\s+)?PR\s*#(\d+)\b/gi)];
    if (repository && shortPullMatches.length > 0) {
      reference = {
        ...repository,
        pullNumber: Number(shortPullMatches[shortPullMatches.length - 1][1]),
      };
    }
  }

  return reference;
}

/** Return every distinct PR mentioned by custody evidence, in evidence order. */
export function extractPullRequestReferences(
  githubIssue: string | null,
  comments: { body: string }[],
): GitHubPullRequestReference[] {
  const references = new Map<string, GitHubPullRequestReference>();
  const texts = [githubIssue || '', ...comments.map(comment => comment.body)];
  let repository: { owner: string; repo: string } | null = null;

  for (const text of texts) {
    for (const match of text.matchAll(PULL_URL_PATTERN)) {
      const value = { owner: match[1], repo: match[2], pullNumber: Number(match[3]) };
      repository = { owner: value.owner, repo: value.repo };
      references.set(`${ value.owner.toLowerCase() }/${ value.repo.toLowerCase() }#${ value.pullNumber }`, value);
    }
    const repositoryMatch = REPOSITORY_REFERENCE_PATTERN.exec(text);
    if (repositoryMatch) repository = { owner: repositoryMatch[1], repo: repositoryMatch[2] };
    if (!repository) continue;
    for (const match of text.matchAll(/\b(?:draft\s+)?PR\s*#(\d+)\b/gi)) {
      const value = { ...repository, pullNumber: Number(match[1]) };
      references.set(`${ value.owner.toLowerCase() }/${ value.repo.toLowerCase() }#${ value.pullNumber }`, value);
    }
  }
  return [...references.values()];
}

export async function resolvePullRequestHead(
  githubIssue: string | null,
  comments: { body: string }[],
): Promise<GitHubPullRequestHead | null> {
  const reference = extractPullRequestReference(githubIssue, comments);
  if (!reference) return null;

  const token = await getIntegrationService().getIntegrationValue('github', 'token');
  if (!token) throw new Error('github_token_unavailable');

  const octokit = new Octokit({ auth: token.value });
  const { data } = await octokit.pulls.get({
    owner:       reference.owner,
    repo:        reference.repo,
    pull_number: reference.pullNumber,
  });
  return { ...reference, sha: data.head.sha.toLowerCase() };
}

export async function resolvePullRequestHeads(
  githubIssue: string | null,
  comments: { body: string }[],
): Promise<GitHubPullRequestHead[]> {
  const references = extractPullRequestReferences(githubIssue, comments);
  if (references.length === 0) return [];
  const token = await getIntegrationService().getIntegrationValue('github', 'token');
  if (!token) throw new Error('github_token_unavailable');
  const octokit = new Octokit({ auth: token.value });
  return Promise.all(references.map(async(reference) => {
    const { data } = await octokit.pulls.get({
      owner: reference.owner, repo: reference.repo, pull_number: reference.pullNumber,
    });
    return { ...reference, sha: data.head.sha.toLowerCase() };
  }));
}
