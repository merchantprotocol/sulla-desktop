// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { HeartbeatSeenIssueRepository } from '../../app/Repositories/HeartbeatSeenIssueRepository';
import { postgresClient } from '../../database/PostgresClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * heartbeat_claim_issue (issue #500, component 3) — the atomic claim + collision guard.
 *
 * Stakes Heartbeat's claim on an issue in the `heartbeat_seen_issues` seen-set
 * BEFORE any GitHub-side action, so two agents (or two cycles) can never both
 * pick up the same issue. The claim is atomic: INSERT ... ON CONFLICT DO NOTHING
 * with the composite primary key as the guard —
 *   - won:  true  → this call inserted the row; the caller owns the issue and
 *                   should proceed to self-assign on GitHub + triage.
 *   - won:  false → the row already existed; another agent/cycle claimed it
 *                   first. The caller must back off and not act.
 *
 * Order of operations in the discovery routine (step 4): claim here FIRST (win
 * the DB race) → only if won, self-assign on GitHub (github_update_issue /
 * label) and record claim_method → triage. Never assign on GitHub before the
 * PG claim, or two agents could both assign before either records the claim.
 *
 * Idempotent by design: re-claiming an already-claimed issue is a safe no-op
 * that reports won=false. Runs in the main process with DB access (like
 * pg_query), NOT a function sandbox (those have no DB access).
 */
export class HeartbeatClaimIssueWorker extends BaseTool {
  name = '';
  description = '';

  protected repository(): HeartbeatSeenIssueRepository {
    return new HeartbeatSeenIssueRepository(postgresClient);
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner = String(input?.owner ?? '').trim();
    const repo = String(input?.repo ?? '').trim();
    const issueNumber = Number(input?.issue_number ?? NaN);

    if (!owner || !repo || !Number.isFinite(issueNumber)) {
      return {
        successBoolean: false,
        responseString: 'Error: owner, repo, and a numeric issue_number are required.',
      };
    }

    const allowedMethods = ['assign', 'label', 'comment', 'preexisting', 'seen'];
    const claimMethod = allowedMethods.includes(String(input?.claim_method))
      ? String(input.claim_method)
      : 'seen';
    const nodeId = input?.node_id != null ? String(input.node_id) : null;
    const title = input?.title != null ? String(input.title) : null;

    try {
      const won = await this.repository().claim({
        owner, repo, issueNumber, nodeId, title, claimMethod,
      });
      const key = `${ owner }/${ repo }#${ issueNumber }`;
      return {
        successBoolean: true,
        responseString: JSON.stringify({
          won,
          issue:  key,
          reason: won
            ? `Claimed ${ key } (method: ${ claimMethod }). Proceed to self-assign on GitHub + triage.`
            : `${ key } was already claimed by a prior cycle/agent. Back off — do not act.`,
        }),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error claiming issue: ${ (error as Error).message }`,
      };
    }
  }
}
