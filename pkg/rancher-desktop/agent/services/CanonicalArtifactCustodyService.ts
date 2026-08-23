import { Octokit } from '@octokit/rest';

import { getIntegrationService } from './IntegrationService';
import { type WorkTaskRecord, WorkItemsModel } from '../database/models/WorkItemsModel';

export interface ProposedCustody {
  artifactType?:         unknown;
  artifactLocation?:     unknown;
  artifactUrl?:          unknown;
  artifactRef?:          unknown;
  contentHash?:          unknown;
  headSha?:              unknown;
  verificationEvidence?: unknown;
}

export interface ProposedDisposition {
  taskId?:          unknown;
  nextState?:       unknown;
  proposedComment?: unknown;
}

interface PullRequestArtifact {
  htmlUrl: string;
  state:   string;
  draft:   boolean;
  headRef: string;
  headSha: string;
  body:    string;
}

interface IssueArtifact {
  htmlUrl: string;
  state:   string;
  number:  number;
}

export interface CanonicalArtifactReader {
  getPullRequest(owner: string, repo: string, pullNumber: number): Promise<PullRequestArtifact>;
  getIssue(owner: string, repo: string, issueNumber: number): Promise<IssueArtifact>;
}

export interface CanonicalCustodyResult {
  valid:             boolean;
  error?:            string;
  artifactLocation?: string;
  artifactUrl?:      string;
  artifactRef?:      string;
  contentHash?:      string;
}

interface GitHubReference {
  owner:  string;
  repo:   string;
  number: number;
}

function parsePullRequestUrl(value: string): GitHubReference | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(value);
  return match ? { owner: match[1], repo: match[2], number: Number(match[3]) } : null;
}

function parseTaskIssue(value: string | null | undefined): GitHubReference | null {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(String(value || ''));
  return match ? { owner: match[1], repo: match[2], number: Number(match[3]) } : null;
}

class VaultGitHubArtifactReader implements CanonicalArtifactReader {
  private async client(): Promise<Octokit> {
    const token = await getIntegrationService().getIntegrationValue('github', 'token');
    if (!token) throw new Error('GitHub token is not configured');
    return new Octokit({ auth: token.value });
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<PullRequestArtifact> {
    const { data } = await (await this.client()).pulls.get({ owner, repo, pull_number: pullNumber });
    return {
      htmlUrl: data.html_url,
      state:   data.state,
      draft:   data.draft === true,
      headRef: data.head.ref,
      headSha: data.head.sha,
      body:    data.body || '',
    };
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<IssueArtifact> {
    const { data } = await (await this.client()).issues.get({ owner, repo, issue_number: issueNumber });
    return { htmlUrl: data.html_url, state: data.state, number: data.number };
  }
}

function invalid(error: string): CanonicalCustodyResult {
  return { valid: false, error };
}

/**
 * Resolve asserted custody against the still-owned Projects row and the live
 * canonical artifact. The graph proposes evidence; only this controller-side
 * verifier is allowed to turn it into a final disposition.
 */
export class CanonicalArtifactCustodyService {
  static async verify(
    origin: WorkTaskRecord,
    custody: ProposedCustody,
    disposition: ProposedDisposition,
    reader: CanonicalArtifactReader = new VaultGitHubArtifactReader(),
  ): Promise<CanonicalCustodyResult> {
    if (String(disposition.taskId || '') !== origin.id) {
      return invalid('proposed disposition is not bound to the originating task');
    }
    if (disposition.nextState !== 'in_review') {
      return invalid('successful custody must propose in_review');
    }
    if (!String(disposition.proposedComment || '').trim()) {
      return invalid('successful custody requires proposed comment evidence');
    }

    const live = await WorkItemsModel.getTask(origin.id);
    if (live?.project_id !== origin.project_id || live.epic_id !== origin.epic_id) {
      return invalid('originating Projects task no longer matches the claimed task');
    }
    if (live.status !== 'in_progress' || live.assignee !== 'dispatcher') {
      return invalid('originating Projects task is no longer owned by this dispatcher');
    }

    const artifactType = String(custody.artifactType || '').toLowerCase();
    if (artifactType === 'code') {
      return CanonicalArtifactCustodyService.verifyCode(origin, custody, reader);
    }
    return CanonicalArtifactCustodyService.verifyNonCode(live, custody, reader);
  }

  private static async verifyCode(
    origin: WorkTaskRecord,
    custody: ProposedCustody,
    reader: CanonicalArtifactReader,
  ): Promise<CanonicalCustodyResult> {
    const artifactUrl = String(custody.artifactUrl || '');
    const requested = parsePullRequestUrl(artifactUrl);
    const expectedIssue = parseTaskIssue(origin.github_issue);
    if (!requested) return invalid('code custody requires a canonical GitHub pull-request URL');
    if (expectedIssue && (requested.owner !== expectedIssue.owner || requested.repo !== expectedIssue.repo)) {
      return invalid('pull request repository does not match the originating task');
    }

    const pull = await reader.getPullRequest(requested.owner, requested.repo, requested.number);
    const assertedHead = String(custody.headSha || '');
    if (pull.htmlUrl !== artifactUrl || pull.state !== 'open' || !pull.draft) {
      return invalid('canonical pull request is missing, closed, or not draft');
    }
    if (!/^[0-9a-f]{40}$/i.test(assertedHead) || pull.headSha !== assertedHead) {
      return invalid('asserted head SHA does not match the canonical pull request head');
    }
    if (String(custody.artifactRef || '') !== pull.headRef) {
      return invalid('asserted branch does not match the canonical pull request head ref');
    }
    if (String(custody.contentHash || '') !== pull.headSha) {
      return invalid('content hash does not match the canonical pull request head');
    }
    if (expectedIssue && !new RegExp(`(?:#|issues\\/)${ expectedIssue.number }(?:\\b|$)`).test(pull.body)) {
      return invalid('canonical pull request does not link the originating task issue');
    }

    return {
      valid:             true,
      artifactLocation: `${ requested.owner }/${ requested.repo }`,
      artifactUrl:       pull.htmlUrl,
      artifactRef:       pull.headRef,
      contentHash:       pull.headSha,
    };
  }

  private static async verifyNonCode(
    liveTask: WorkTaskRecord,
    custody: ProposedCustody,
    reader: CanonicalArtifactReader,
  ): Promise<CanonicalCustodyResult> {
    const issue = parseTaskIssue(liveTask.github_issue);
    if (issue) {
      const live = await reader.getIssue(issue.owner, issue.repo, issue.number);
      const expectedUrl = `https://github.com/${ issue.owner }/${ issue.repo }/issues/${ issue.number }`;
      if (live.htmlUrl !== expectedUrl || live.number !== issue.number || String(custody.artifactUrl || '') !== live.htmlUrl) {
        return invalid('non-code artifact does not match the live authoritative task issue');
      }
      return {
        valid:             true,
        artifactLocation: `${ issue.owner }/${ issue.repo }`,
        artifactUrl:       live.htmlUrl,
        artifactRef:       `issue-${ live.number }`,
        contentHash:       String(custody.contentHash || live.state),
      };
    }

    if (String(custody.artifactLocation || '') !== `projects:${ liveTask.id }` ||
        String(custody.artifactRef || '') !== liveTask.id) {
      return invalid('non-code custody must name the live originating Projects task');
    }
    return {
      valid:             true,
      artifactLocation: `projects:${ liveTask.id }`,
      artifactRef:       liveTask.id,
      contentHash:       String(liveTask.updated_at || ''),
    };
  }
}
