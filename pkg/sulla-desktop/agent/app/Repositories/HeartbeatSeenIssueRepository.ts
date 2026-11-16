// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { PostgresClient } from '../../database/PostgresClient';

export interface HeartbeatIssueClaim {
  owner:       string;
  repo:        string;
  issueNumber: number;
  nodeId:      string | null;
  title:       string | null;
  claimMethod: string;
}

export interface HeartbeatIssueKey {
  owner:  string;
  repo:   string;
  number: number;
}

/** Reads and writes the `heartbeat_seen_issues` seen-set used by heartbeat_claim_issue / heartbeat_new_issues. */
export class HeartbeatSeenIssueRepository {
  constructor(private readonly client: Pick<PostgresClient, 'query'>) {}

  /**
   * Atomic claim: true when this call inserted the row (won the claim),
   * false when the row already existed (another agent/cycle claimed it first).
   */
  async claim(claim: HeartbeatIssueClaim): Promise<boolean> {
    // ON CONFLICT DO NOTHING + RETURNING: a returned row means we inserted it
    // (won the claim); an empty result means the row already existed (lost).
    const rows = await this.client.query(
      `INSERT INTO heartbeat_seen_issues
           (repo_owner, repo_name, issue_number, issue_node_id, title, claim_method, claimed_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (repo_owner, repo_name, issue_number) DO NOTHING
         RETURNING repo_owner`,
      [claim.owner, claim.repo, claim.issueNumber, claim.nodeId, claim.title, claim.claimMethod],
    );

    return rows.length > 0;
  }

  /**
   * Anti-join: the `owner/repo#number` keys of the candidates already present
   * in the seen-set. One query over just the candidate keys.
   */
  async seenKeys(candidates: HeartbeatIssueKey[]): Promise<Set<string>> {
    if (candidates.length === 0) return new Set();

    // Build a VALUES list and match on the composite (owner, repo, number) key.
    const params: any[] = [];
    const tuples = candidates.map((n) => {
      const base = params.length;
      params.push(n.owner, n.repo, n.number);
      return `($${ base + 1 }, $${ base + 2 }, $${ base + 3 }::int)`;
    }).join(', ');

    const rows = await this.client.query<{ repo_owner: string; repo_name: string; issue_number: number }>(
      `SELECT s.repo_owner, s.repo_name, s.issue_number
           FROM heartbeat_seen_issues s
           JOIN (VALUES ${ tuples }) AS c(owner, repo, number)
             ON s.repo_owner = c.owner
            AND s.repo_name  = c.repo
            AND s.issue_number = c.number`,
      params,
    );

    return new Set(rows.map(r => `${ r.repo_owner }/${ r.repo_name }#${ r.issue_number }`));
  }
}
