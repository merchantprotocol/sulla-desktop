import { postgresClient } from '../../database/PostgresClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * heartbeat_new_issues (issue #500, component 3) — the "touched-before" filter.
 *
 * Given the open-issue union from `scan_active_issues`, returns only the issues
 * Heartbeat has NOT handled before, so the discovery routine never re-triages
 * the same issue. An issue is NEW when ALL of:
 *   - it is not already in the `heartbeat_seen_issues` seen-set (PG anti-join), AND
 *   - it is not already assigned to Heartbeat's login (from the scan payload), AND
 *   - it does not already carry the claim label (from the scan payload).
 *
 * The assignee/label signals come free in the scan payload — no extra GitHub
 * calls. A triage-comment check needs a per-issue API round-trip, so it stays in
 * the routine (step 4), not here. Read-only, zero-LLM, deterministic. Runs in the
 * main process with DB access (like pg_query), NOT a function sandbox.
 *
 * Input issue shape (tolerant — missing fields are treated as absent):
 *   { owner, repo, number|issue_number, node_id?, title?,
 *     assignees?: (string | {login})[], labels?: (string | {name})[] }
 */
export class HeartbeatNewIssuesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const heartbeatLogin = String(input?.heartbeat_login ?? '').toLowerCase().trim();
    const claimLabel = String(input?.claim_label ?? 'heartbeat').toLowerCase().trim();

    const rawIssues = input?.issues;
    const issues = Array.isArray(rawIssues) ? rawIssues : [];
    if (issues.length === 0) {
      return {
        successBoolean: true,
        responseString: JSON.stringify({ new_count: 0, filtered_count: 0, new_issues: [] }),
      };
    }

    // Normalize each incoming issue to a stable key + the GitHub-side signals.
    const normalized = issues.map((i: any) => {
      const owner = String(i?.owner ?? i?.repo_owner ?? '').trim();
      const repo = String(i?.repo ?? i?.repo_name ?? '').trim();
      const number = Number(i?.number ?? i?.issue_number ?? NaN);
      const assignees: string[] = Array.isArray(i?.assignees)
        ? i.assignees.map((a: any) => String(typeof a === 'string' ? a : a?.login ?? '').toLowerCase())
        : [];
      const labels: string[] = Array.isArray(i?.labels)
        ? i.labels.map((l: any) => String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase())
        : [];
      return { owner, repo, number, assignees, labels, raw: i };
    }).filter(n => n.owner && n.repo && Number.isFinite(n.number));

    // Drop anything already claimed on GitHub (assigned to us / bearing our label).
    const notClaimedOnGitHub = normalized.filter((n) => {
      const assignedToUs = heartbeatLogin ? n.assignees.includes(heartbeatLogin) : false;
      const hasClaimLabel = claimLabel ? n.labels.includes(claimLabel) : false;
      return !assignedToUs && !hasClaimLabel;
    });

    if (notClaimedOnGitHub.length === 0) {
      return {
        successBoolean: true,
        responseString: JSON.stringify({
          new_count:      0,
          filtered_count: normalized.length,
          new_issues:     [],
        }),
      };
    }

    // Anti-join against the PG seen-set. One query over just the candidate keys.
    // Build a VALUES list and match on the composite (owner, repo, number) key.
    const params: any[] = [];
    const tuples = notClaimedOnGitHub.map((n) => {
      const base = params.length;
      params.push(n.owner, n.repo, n.number);
      return `($${ base + 1 }, $${ base + 2 }, $${ base + 3 }::int)`;
    }).join(', ');

    let seenKeys = new Set<string>();
    try {
      const rows = await postgresClient.query<{ repo_owner: string; repo_name: string; issue_number: number }>(
        `SELECT s.repo_owner, s.repo_name, s.issue_number
           FROM heartbeat_seen_issues s
           JOIN (VALUES ${ tuples }) AS c(owner, repo, number)
             ON s.repo_owner = c.owner
            AND s.repo_name  = c.repo
            AND s.issue_number = c.number`,
        params,
      );
      seenKeys = new Set(rows.map(r => `${ r.repo_owner }/${ r.repo_name }#${ r.issue_number }`));
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error querying heartbeat_seen_issues: ${ (error as Error).message }`,
      };
    }

    const newIssues = notClaimedOnGitHub
      .filter(n => !seenKeys.has(`${ n.owner }/${ n.repo }#${ n.number }`))
      .map(n => n.raw);

    return {
      successBoolean: true,
      responseString: JSON.stringify({
        new_count:      newIssues.length,
        filtered_count: normalized.length - newIssues.length,
        new_issues:     newIssues,
      }),
    };
  }
}
