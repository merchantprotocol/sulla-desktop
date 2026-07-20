import { postgresClient } from '../../database/PostgresClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * find_repeated_tasks (issue #499, component 3) — the promotion detector.
 *
 * The stewardship flywheel is: detect repetition → decide (function vs routine)
 * → codify → register → maintain → score. This tool is the FIRST step: it mines
 * task history for work that has recurred often enough to be worth codifying,
 * so Heartbeat can push it DOWN the cost ladder — expensive ad-hoc agent labor →
 * routine (LLM only on fire) → deterministic function (~0 tokens).
 *
 * Reads the `routine_promotion_candidates` view (migration 0031), which clusters
 * shell/catalog actions from the per-action tool log (`claude_messages`
 * role='tool', "$ <command>" rows) by a deterministic shape-signature. No LLM to
 * produce the candidate set — pure SQL aggregation.
 *
 * THRESHOLD is on DISTINCT CONVERSATIONS, not raw occurrences. A command run 32×
 * inside ONE debugging session is not recurring work; the same command seen
 * across many separate sessions is. Gating on distinct conversations is what
 * keeps this from promoting within-session bursts (and guards against routine
 * sprawl — 100 junk routines is the same token-mess moved upstream). Default
 * threshold 3, per the issue.
 *
 * Runs in the main process with DB access (like pg_query) — NOT a function
 * sandbox (those have no DB access).
 */
export class FindRepeatedTasksWorker extends BaseTool {
  name = 'find_repeated_tasks';
  description = 'Promotion detector: scans task history for operations that have recurred across >= threshold DISTINCT sessions and returns them as candidates to codify into a routine (needs judgment) or a zero-token function (deterministic). Deterministic shape-signature over the per-action tool log; zero-LLM. Args: threshold (optional, default 3 — minimum distinct conversations), limit (optional, default 20).';

  schemaDef = {
    threshold: { type: 'number' as const, optional: true, description: 'Minimum number of DISTINCT conversations a signature must appear in to count as recurring. Default 3.' },
    limit:     { type: 'number' as const, optional: true, description: 'Max candidates to return, most-recurring first. Default 20.' },
  };

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const threshold = Math.min(Math.max(Number(input.threshold ?? 3) || 3, 2), 100);
    const limit     = Math.min(Math.max(Number(input.limit ?? 20) || 20, 1), 100);

    try {
      const rows = await postgresClient.query(`
        SELECT
          signature,
          occurrences,
          conversations,
          span_days,
          to_char(last_seen, 'YYYY-MM-DD') AS last_seen
        FROM routine_promotion_candidates
        WHERE conversations >= $1
        ORDER BY conversations DESC, occurrences DESC
        LIMIT $2
      `, [threshold, limit]);

      const list = Array.isArray(rows) ? rows : [];

      if (list.length === 0) {
        return {
          successBoolean: true,
          responseString: `No repeated tasks at threshold >= ${ threshold } distinct sessions. Nothing to promote right now.`,
        };
      }

      const header = `PROMOTION CANDIDATES: ${ list.length } operation(s) seen across >= ${ threshold } distinct sessions`
        + ' — codify the deterministic ones as functions, the judgment ones as routines:';

      const lines = list.map((r: any) => {
        const span = Number(r.span_days) > 0 ? `, over ${ r.span_days }d` : '';
        return `  • ${ r.signature } — ${ r.conversations } sessions / ${ r.occurrences } runs${ span } (last ${ r.last_seen })`;
      });

      return {
        successBoolean: true,
        responseString: [header, ...lines,
          'Promote: prefer a zero-token function when no judgment is needed; a routine when it does. Register it in the catalog, and schedule it if it recurs on a clock.'].join('\n'),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error finding repeated tasks: ${ (error as Error).message }`,
      };
    }
  }
}
