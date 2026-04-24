import { BaseTool, ToolResponse } from '../base';

/**
 * Read function_runs history. Every `function_run` invocation writes a row
 * with slug, runtime, inputs, outputs, success, error stage, and duration.
 * This tool queries that table with the usual filters.
 */
export class FunctionRunsWorker extends BaseTool {
  name = 'function_runs';
  description = 'Query the function_run history table. Answers "why did my function fail yesterday?" and "show me the last 10 runs of X".';

  schemaDef = {
    slug:          { type: 'string' as const,  optional: true, description: 'Filter to one function slug.' },
    only_failures: { type: 'boolean' as const, optional: true, description: 'If true, return only runs where success=false.' },
    since:         { type: 'string' as const,  optional: true, description: 'ISO-8601 timestamp — only runs at/after this time.' },
    limit:         { type: 'number' as const,  optional: true, description: 'Max rows to return (default 50, cap 200).' },
    verbose:       { type: 'boolean' as const, optional: true, description: 'If true, include full inputs + outputs in the response. Default false (shows summary only).' },
  };

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(200, input.limit) : 50;
    const slug  = typeof input.slug === 'string' ? input.slug.trim() : '';
    const onlyFails = input.only_failures === true;
    const sinceRaw  = typeof input.since === 'string' ? input.since.trim() : '';
    const verbose   = input.verbose === true;

    const where: string[] = [];
    const params: unknown[] = [];

    if (slug) {
      params.push(slug);
      where.push(`slug = $${ params.length }`);
    }
    if (onlyFails) where.push('success = false');
    if (sinceRaw) {
      const since = new Date(sinceRaw);
      if (Number.isNaN(since.getTime())) {
        return { successBoolean: false, responseString: `"since" is not a valid ISO timestamp: "${ sinceRaw }".` };
      }
      params.push(since.toISOString());
      where.push(`started_at >= $${ params.length }`);
    }

    const whereClause = where.length > 0 ? `WHERE ${ where.join(' AND ') }` : '';
    params.push(limit);
    const limitIdx = params.length;

    const sql = `
      SELECT id, slug, version, runtime, inputs, outputs, success, error_stage, error,
             duration_ms, started_at, completed_at
      FROM function_runs
      ${ whereClause }
      ORDER BY started_at DESC
      LIMIT $${ limitIdx }
    `;

    try {
      const { postgresClient } = await import('../../database/PostgresClient');
      const rows = await postgresClient.query<any>(sql, params);
      if (rows.length === 0) {
        return { successBoolean: true, responseString: 'No function runs matched the filter.' };
      }

      const lines = rows.map((r: any) => {
        const status = r.success ? '✓' : '✗';
        const dur = r.duration_ms ? `${ r.duration_ms }ms` : '?ms';
        const head = `${ status } [${ r.started_at }] ${ r.slug } v${ r.version } (${ r.runtime || '?' }) — ${ dur }`;
        const errTag = r.error_stage ? ` [${ r.error_stage }]` : '';
        const errMsg = r.error ? `\n    error${ errTag }: ${ String(r.error).slice(0, 300) }` : '';
        if (!verbose) return head + errMsg;
        const inputs = r.inputs ? JSON.stringify(r.inputs) : '{}';
        const outputs = r.outputs ? JSON.stringify(r.outputs) : 'null';
        return `${ head }${ errMsg }\n    inputs:  ${ inputs.slice(0, 400) }\n    outputs: ${ outputs.slice(0, 400) }`;
      });

      return {
        successBoolean: true,
        responseString: `${ rows.length } run(s):\n${ lines.join('\n') }`,
      };
    } catch (err) {
      return { successBoolean: false, responseString: `Function runs query failed: ${ (err as Error).message }` };
    }
  }
}
