import { randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';

export interface WorkFileClaimRecord {
  id:            string;
  repo_root:     string;
  path_glob:     string;
  owner_job_id:  string | null;
  owner_label:   string;
  worktree_path: string;
  created_at:    string | Date;
  released_at:   string | Date | null;
}

export class WorkFileClaimModel {
  static async create(input: {
    repoRoot: string;
    pathGlob: string;
    ownerJobId?: string;
    ownerLabel: string;
    worktreePath: string;
  }): Promise<WorkFileClaimRecord> {
    const rows = await postgresClient.query<WorkFileClaimRecord>(`
      INSERT INTO work_file_claims
        (id, repo_root, path_glob, owner_job_id, owner_label, worktree_path)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (repo_root, path_glob, owner_label, worktree_path)
        WHERE released_at IS NULL
      DO UPDATE SET owner_job_id = EXCLUDED.owner_job_id
      RETURNING *
    `, [
      randomUUID(), input.repoRoot, input.pathGlob, input.ownerJobId ?? null,
      input.ownerLabel, input.worktreePath,
    ]);

    return rows[0];
  }

  static listActive(repoRoot?: string): Promise<WorkFileClaimRecord[]> {
    return postgresClient.query<WorkFileClaimRecord>(`
      SELECT *
        FROM work_file_claims
       WHERE released_at IS NULL
         AND ($1::text IS NULL OR repo_root = $1)
       ORDER BY repo_root, created_at, path_glob
    `, [repoRoot ?? null]);
  }

  static async release(input: {
    repoRoot: string;
    ownerLabel?: string;
    claimIds?: string[];
  }): Promise<WorkFileClaimRecord[]> {
    if (input.claimIds?.length) {
      return postgresClient.query<WorkFileClaimRecord>(`
        UPDATE work_file_claims
           SET released_at = NOW()
         WHERE repo_root = $1
           AND id = ANY($2::text[])
           AND released_at IS NULL
        RETURNING *
      `, [input.repoRoot, input.claimIds]);
    }

    return postgresClient.query<WorkFileClaimRecord>(`
      UPDATE work_file_claims
         SET released_at = NOW()
       WHERE repo_root = $1
         AND owner_label = $2
         AND released_at IS NULL
      RETURNING *
    `, [input.repoRoot, input.ownerLabel]);
  }
}
