// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AppleScriptAuditRepository } from '../../app/Repositories/AppleScriptAuditRepository';
import { postgresClient } from '../../database/PostgresClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Read the AppleScript audit log. Every `applescript_execute` call writes a
 * row to `applescript_audit`; this tool queries it with the usual filters.
 */
export class ApplescriptAuditLogWorker extends BaseTool {
  name = '';
  description = '';

  protected repository(): AppleScriptAuditRepository {
    return new AppleScriptAuditRepository(postgresClient);
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const limit     = typeof input.limit === 'number' && input.limit > 0 ? Math.min(200, input.limit) : 50;
    const targetApp = typeof input.target_app === 'string' ? input.target_app.trim() : '';
    const onlyFails = input.only_failures === true;
    const sinceRaw  = typeof input.since === 'string' ? input.since.trim() : '';

    let sinceIso: string | undefined;
    if (sinceRaw) {
      const since = new Date(sinceRaw);
      if (Number.isNaN(since.getTime())) {
        return { successBoolean: false, responseString: `"since" is not a valid ISO timestamp: "${ sinceRaw }".` };
      }
      sinceIso = since.toISOString();
    }

    try {
      const rows = await this.repository().recent({ targetApp: targetApp || undefined, onlyFailures: onlyFails, sinceIso, limit });

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
