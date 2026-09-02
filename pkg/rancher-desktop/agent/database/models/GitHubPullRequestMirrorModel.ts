import { postgresClient } from '../PostgresClient';

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
  static async claim(input: ClaimGitHubPullRequestMirrorInput): Promise<GitHubPullRequestMirrorRecord> {
    const rows = await postgresClient.query<GitHubPullRequestMirrorRecord>(`
      INSERT INTO github_pr_project_mirrors
        (owner, repository, pull_number, project_id, epic_id, parent_id)
      VALUES (lower($1), lower($2), $3, $4, $5, $6)
      ON CONFLICT (provider, owner, repository, pull_number) DO UPDATE SET
        project_id = EXCLUDED.project_id,
        epic_id = EXCLUDED.epic_id,
        parent_id = EXCLUDED.parent_id,
        last_seen_at = now(),
        updated_at = now(),
        archived_at = NULL
      RETURNING *`, [
      input.owner, input.repository, input.pullNumber,
      input.projectId, input.epicId, input.parentId,
    ]);
    return rows[0];
  }

  static async listForScope(projectId: string, epicId: string): Promise<GitHubPullRequestMirrorRecord[]> {
    return postgresClient.query<GitHubPullRequestMirrorRecord>(`
      SELECT owner, repository, pull_number, task_id, snapshot_fingerprint,
             remote_updated_at, remote_disposition, sync_generation
        FROM github_pr_project_mirrors
       WHERE project_id = $1 AND epic_id = $2 AND archived_at IS NULL
       ORDER BY owner, repository, pull_number`, [projectId, epicId]);
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
    await postgresClient.query(`
      UPDATE github_pr_project_mirrors SET
        task_id = $4,
        snapshot_fingerprint = $5,
        remote_updated_at = $6,
        remote_disposition = $7,
        sync_generation = CASE WHEN snapshot_fingerprint IS DISTINCT FROM $5
          THEN sync_generation + 1 ELSE sync_generation END,
        last_seen_at = now(),
        last_error = NULL,
        updated_at = now()
      WHERE provider = 'github' AND owner = lower($1) AND repository = lower($2)
        AND pull_number = $3 AND archived_at IS NULL`, [
      input.owner, input.repository, input.pullNumber, input.taskId,
      input.fingerprint, input.remoteUpdatedAt, input.disposition,
    ]);
  }

  static async recordError(owner: string, repository: string, pullNumber: number, message: string): Promise<void> {
    await postgresClient.query(`
      UPDATE github_pr_project_mirrors SET last_error = $4, updated_at = now()
      WHERE provider = 'github' AND owner = lower($1) AND repository = lower($2)
        AND pull_number = $3 AND archived_at IS NULL`, [owner, repository, pullNumber, message.slice(0, 2000)]);
  }
}
