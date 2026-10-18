import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';

export type GitHubPullRequestDisposition = 'unknown' | 'open' | 'merged' | 'closed_unmerged';

export interface GitHubPullRequestMirrorRecord {
  owner:                string;
  repository:           string;
  pull_number:          number;
  task_id:              string | null;
  snapshot_fingerprint: string | null;
  remote_updated_at:    string | null;
  remote_disposition:   GitHubPullRequestDisposition;
  sync_generation:      number;
}

export interface ClaimGitHubPullRequestMirrorInput {
  owner:      string;
  repository: string;
  pullNumber: number;
  projectId:  string;
  epicId:     string;
  parentId:   string | null;
}

/** Durable identity/snapshot ledger for the disabled-by-default PR projection. */
export class GitHubPullRequestMirrorModel {
  static claim(input: ClaimGitHubPullRequestMirrorInput): Promise<GitHubPullRequestMirrorRecord> {
    return getProjectsApplicationService().claimGitHubPullRequestMirror(input);
  }

  static listForScope(projectId: string, epicId: string): Promise<GitHubPullRequestMirrorRecord[]> {
    return getProjectsApplicationService().listGitHubPullRequestMirrors(projectId, epicId);
  }

  static async recordSnapshot(input: {
    owner:           string;
    repository:      string;
    pullNumber:      number;
    taskId:          string;
    fingerprint:     string;
    remoteUpdatedAt: string;
    disposition:     GitHubPullRequestDisposition;
  }): Promise<void> {
    await getProjectsApplicationService().recordGitHubPullRequestSnapshot(input);
  }

  static async recordError(owner: string, repository: string, pullNumber: number, message: string): Promise<void> {
    await getProjectsApplicationService().recordGitHubPullRequestError(owner, repository, pullNumber, message);
  }
}
