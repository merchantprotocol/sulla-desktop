// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { NotificationRepository } from '../../app/Repositories/NotificationRepository';
import { postgresClient } from '../../database/PostgresClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Read the notification history. Every `notify_user` call writes a row; this
 * tool queries it so the agent can answer "what did you tell me?" or "did
 * that notification actually go out?".
 */
export class NotifyHistoryWorker extends BaseTool {
  name = '';
  description = '';

  protected repository(): NotificationRepository {
    return new NotificationRepository(postgresClient);
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const limit         = typeof input.limit === 'number' && input.limit > 0 ? Math.min(200, input.limit) : 50;
    const target        = typeof input.target === 'string' ? input.target.trim().toLowerCase() : '';
    const onlyFails     = input.only_failures === true;
    const sinceRaw      = typeof input.since === 'string' ? input.since.trim() : '';

    let sinceIso: string | undefined;
    if (target && !['desktop', 'mobile'].includes(target)) {
      return { successBoolean: false, responseString: `"target" must be "desktop" or "mobile".` };
    }
    if (sinceRaw) {
      const since = new Date(sinceRaw);
      if (Number.isNaN(since.getTime())) {
        return { successBoolean: false, responseString: `"since" is not a valid ISO timestamp: "${ sinceRaw }".` };
      }
      sinceIso = since.toISOString();
    }

    try {
      const rows = await this.repository().recent({ target: target || undefined, onlyFailures: onlyFails, sinceIso, limit });
      if (rows.length === 0) {
        return { successBoolean: true, responseString: 'No notifications matched the filter.' };
      }
      const lines = rows.map((r: any) => {
        const tgt = Array.isArray(r.targets) ? r.targets.join(',') : JSON.stringify(r.targets);
        const status = r.delivered ? '✓' : '✗';
        const err = r.error ? ` — err: ${ String(r.error).slice(0, 120) }` : '';
        return `${ status } [${ r.sent_at }] → ${ tgt }: "${ r.title }" — ${ String(r.message).slice(0, 120) }${ String(r.message).length > 120 ? '…' : '' }${ err }`;
      });
      return {
        successBoolean: true,
        responseString: `${ rows.length } notification(s):\n${ lines.join('\n') }`,
      };
    } catch (err) {
      return { successBoolean: false, responseString: `History query failed: ${ (err as Error).message }` };
    }
  }
}
