import { postgresClient } from '../../database/PostgresClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * routine_report (issue #499) — the on-demand drill-down / "stack trace".
 *
 * The digest is the alarm (status only); this is the diagnosis payload. Given a
 * routine slug (and optionally a specific executionId or last_k), returns each
 * run's status/timing/error PLUS its step-by-step tool-call trace pulled from
 * workflow_checkpoints (node label, subtype, sequence, truncated output) — the
 * "why it failed". Verbose by design, so it lives behind a PULL: fetched only
 * when the digest flags something, never dumped into standing context.
 *
 * Runs in the main process with DB access (like pg_query).
 */
export class RoutineReportWorker extends BaseTool {
  name = 'routine_report';
  description = 'Drill-down report for a routine: last-run status, timing, error, and the step-by-step tool-call trace (from workflow_checkpoints) explaining why it did what it did. Call this when routines_digest flags a routine failed/blocked/stalled. Args: slug (required), executionId (optional, target one run), last_k (optional, default 1).';

  schemaDef = {
    slug:        { type: 'string' as const, optional: true, description: 'Routine slug (source_template_slug), e.g. "planning-triage". Provide slug or executionId.' },
    executionId: { type: 'string' as const, optional: true, description: 'Target a specific execution_id instead of the latest run(s).' },
    last_k:      { type: 'number' as const, optional: true, description: 'How many most-recent runs to report. Default 1 (latest).' },
  };

  private truncate(val: any, max = 240): string {
    let s: string;
    try {
      s = typeof val === 'string' ? val : JSON.stringify(val);
    } catch {
      s = String(val);
    }
    if (!s) return '';
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > max ? `${ s.slice(0, max) }…` : s;
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const slug = input.slug ? String(input.slug).trim() : null;
    const executionId = input.executionId ? String(input.executionId).trim() : null;
    const k = Math.min(Math.max(Number(input.last_k ?? 1) || 1, 1), 10);

    if (!slug && !executionId) {
      return {
        successBoolean: false,
        responseString: 'Provide a routine slug (preferred) or an executionId.',
      };
    }

    try {
      const runs = await postgresClient.query(`
        SELECT execution_id, routine_slug, routine_name, status,
               started_at, completed_at, duration_seconds, error, is_zombie
        FROM routine_run_history
        WHERE ($1::text IS NULL OR routine_slug = $1)
          AND ($2::text IS NULL OR execution_id = $2)
        ORDER BY started_at DESC
        LIMIT $3
      `, [slug, executionId, k]);

      const runRows = Array.isArray(runs) ? runs : [];
      if (runRows.length === 0) {
        return {
          successBoolean: true,
          responseString: `No runs found for ${ slug ?? executionId }. (Routine may be armed but never fired.)`,
        };
      }

      const blocks: string[] = [];
      for (const run of runRows) {
        const checkpoints = await postgresClient.query(`
          SELECT sequence, node_id, node_label, node_subtype, node_output
          FROM workflow_checkpoints
          WHERE execution_id = $1
          ORDER BY sequence ASC
        `, [run.execution_id]);
        const cpRows = Array.isArray(checkpoints) ? checkpoints : [];

        const head =
          `── ${ run.routine_slug } · ${ run.execution_id }\n`
          + `   status: ${ run.status }${ run.is_zombie ? ' (ZOMBIE)' : '' }`
          + `  ·  started: ${ run.started_at ?? 'n/a' }`
          + `  ·  ${ run.duration_seconds != null ? `${ run.duration_seconds }s` : 'unfinished' }`
          + (run.error ? `\n   error: ${ this.truncate(run.error, 400) }` : '');

        let trace: string;
        if (cpRows.length === 0) {
          trace = '   trace: (no checkpoints recorded for this run)';
        } else {
          trace = ['   trace:',
            ...cpRows.map((c: any) =>
              `     ${ c.sequence }. ${ c.node_label ?? c.node_id } [${ c.node_subtype ?? '?' }]`
              + (c.node_output ? ` → ${ this.truncate(c.node_output) }` : ''))].join('\n');
        }

        blocks.push(`${ head }\n${ trace }`);
      }

      return {
        successBoolean: true,
        responseString: blocks.join('\n\n'),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error building routine report: ${ (error as Error).message }`,
      };
    }
  }
}
