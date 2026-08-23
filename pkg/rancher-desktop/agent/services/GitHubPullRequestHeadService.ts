import { Octokit } from '@octokit/rest';

import { getIntegrationService } from './IntegrationService';

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
    for (const match of text.matchAll(/github\.com\/([^/\s]+)\/([^/#\s]+)\/pull\/(\d+)/gi)) {
      reference = { owner: match[1], repo: match[2], pullNumber: Number(match[3]) };
      repository = { owner: match[1], repo: match[2] };
    }
    const repositoryMatch = /(?:github\.com\/)?([^/\s]+)\/([^/#\s]+)#\d+/i.exec(text);
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
