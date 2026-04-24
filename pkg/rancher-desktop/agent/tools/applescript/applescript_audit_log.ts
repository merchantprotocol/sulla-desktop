import { postgresClient } from '../../database/PostgresClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Read the AppleScript audit log. Every `applescript_execute` call writes a
 * row to `applescript_audit`; this tool queries it with the usual filters.
 */
export class ApplescriptAuditLogWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const limit     = typeof input.limit === 'number' && input.limit > 0 ? Math.min(200, input.limit) : 50;
    const targetApp = typeof input.target_app === 'string' ? input.target_app.trim() : '';
    const onlyFails = input.only_failures === true;
    const sinceRaw  = typeof input.since === 'string' ? input.since.trim() : '';

    const where: string[] = [];
    const params: unknown[] = [];

    if (targetApp) {
      params.push(targetApp);
      where.push(`target_app = $${ params.length }`);
    }
    if (onlyFails) {
      where.push('success = false');
    }
    if (sinceRaw) {
      const since = new Date(sinceRaw);
      if (Number.isNaN(since.getTime())) {
        return { successBoolean: false, responseString: `"since" is not a valid ISO timestamp: "${ sinceRaw }".` };
      }
      params.push(since.toISOString());
      where.push(`executed_at >= $${ params.length }`);
    }

    const whereClause = where.length > 0 ? `WHERE ${ where.join(' AND ') }` : '';
    params.push(limit);
    const limitParamIdx = params.length;

    const sql = `
      SELECT id, target_app, action_type, script, success, duration_ms,
             response_chars, error, executed_at
      FROM applescript_audit
      ${ whereClause }
      ORDER BY executed_at DESC
      LIMIT $${ limitParamIdx }
    `;

    try {
      const rows = await postgresClient.query<any>(sql, params);

      if (rows.length === 0) {
        return { successBoolean: true, responseString: 'No AppleScript executions matched the filter.' };
      }

      const lines = rows.map(r => {
        const status = r.success ? '✓' : '✗';
        const dur = r.duration_ms ? `${ r.duration_ms }ms` : '?ms';
        const head = `${ status } [${ r.executed_at }] ${ r.target_app } (${ r.action_type }) — ${ dur }, ${ r.response_chars ?? 0 } chars`;
        const snippet = (r.script || '').slice(0, 120).replace(/\s+/g, ' ').trim();
        const err = r.error ? `\n    error: ${ r.error.slice(0, 200) }` : '';
        return `${ head }\n    script: ${ snippet }${ snippet.length >= 120 ? '…' : '' }${ err }`;
      });

      return {
        successBoolean: true,
        responseString: `${ rows.length } execution(s):\n${ lines.join('\n\n') }`,
      };
    } catch (err) {
      return { successBoolean: false, responseString: `Audit query failed: ${ (err as Error).message }` };
    }
  }
}
