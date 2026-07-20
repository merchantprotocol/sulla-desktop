import { postgresClient } from '../../database/PostgresClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * routines_digest (issue #499) — the anti-token-burn core.
 *
 * Deterministic, zero-LLM standing context for Heartbeat: a delta + exceptions-
 * ONLY summary of routine health. Successes are suppressed. An all-green cycle
 * with nothing new collapses to a SINGLE line ("N routines armed, all green, no
 * change"), so injecting it every cycle costs almost nothing. Only surfaces
 * routines that deviate — last run failed, a zombie run, or newly created in the
 * last 24h — reading from the `routine_exceptions` / `routine_digest_summary`
 * views (migration 0030) over the 0029 scorecard spine. No LLM to produce.
 *
 * Runs in the main process with DB access (like pg_query) — NOT a function
 * sandbox (those have no DB access).
 */
export class RoutinesDigestWorker extends BaseTool {
  name = 'routines_digest';
  description = 'Deterministic delta + exceptions-only digest of routine health (zero-LLM). All-green + no change = one line; otherwise lists only routines whose last run failed, that have a zombie run, or that were newly created in the last 24h. Reads the routine_exceptions/routine_digest_summary views.';

  schemaDef = {};

  private renderReasons(raw: any): string {
    // reasons is a Postgres text[]: the driver may hand it back as a JS array
    // or as the literal string "{failed,new}". Normalize either shape.
    if (Array.isArray(raw)) return raw.join(', ');
    const s = String(raw ?? '').replace(/^\{|\}$/g, '').trim();
    return s.length ? s.split(',').map(x => x.replace(/^"|"$/g, '')).join(', ') : '';
  }

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    try {
      const summaryRows = await postgresClient.query('SELECT * FROM routine_digest_summary');
      const summary = Array.isArray(summaryRows) ? summaryRows[0] : summaryRows;

      const exceptions = await postgresClient.query(`
        SELECT
          routine_slug,
          reasons,
          last_run_status,
          CASE
            WHEN last_run_at IS NULL THEN 'never fired'
            ELSE ROUND(EXTRACT(EPOCH FROM (NOW() - last_run_at)) / 60)::text || 'm ago'
          END AS last_run_ago
        FROM routine_exceptions
        ORDER BY (last_run_status = 'failed') DESC, routine_slug
      `);
      const rows = Array.isArray(exceptions) ? exceptions : [];

      const armed = Number(summary?.enabled_count ?? 0);

      if (rows.length === 0) {
        return {
          successBoolean: true,
          responseString: `ROUTINES: ${ armed } armed, all green, no change.`,
        };
      }

      const failed = Number(summary?.failed_count ?? 0);
      const zombie = Number(summary?.zombie_count ?? 0);
      const fresh  = Number(summary?.new_count ?? 0);

      const header = `ROUTINES: ${ armed } armed — ${ rows.length } need a look`
        + ` (${ failed } failed, ${ zombie } zombie, ${ fresh } new):`;

      const lines = rows.map((r: any) => {
        const reasons = this.renderReasons(r.reasons);
        return `  • ${ r.routine_slug } [${ reasons }] — last run ${ r.last_run_status ?? 'n/a' } (${ r.last_run_ago })`;
      });

      return {
        successBoolean: true,
        responseString: [header, ...lines,
          'Pull routine_report(<slug>) for the failing run\'s tool-call trace.'].join('\n'),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error building routines digest: ${ (error as Error).message }`,
      };
    }
  }
}
