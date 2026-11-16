// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Queryable } from '../db.js';

/** Already-validated /v1/human/activity filters (validation and 400s stay in HumanActivityRoutes). */
export interface HumanActivityFilter {
  principalId: string;
  /** A UUID; filters to one item. */
  item?: string;
  /** `agent`, `human`, `all` or undefined. */
  actor?: unknown;
  /** `true` filters to blocked events. */
  blocked?: unknown;
  /** A parseable timestamp; lower bound on created_at. */
  from?: string;
  /** Raw search text (trimmed here; at most 160 characters once trimmed). */
  query?: string;
  /** Rows to read (LIMIT). */
  window: number;
  /** Rows to skip (OFFSET). */
  offset: number;
}

/**
 * Reads the human vault activity feed: the principal's own non-org audit rows (and rows for items
 * they own), newest first, with optional item/actor/blocked/from/search filters.
 */
export class PostgresHumanActivityRepository {
  constructor(private readonly client: Queryable) {}

  async listForPrincipal(filter: HumanActivityFilter): Promise<Array<Record<string, any>>> {
    const conditions = ['a.actor_user_id=$1', 'a.org_id IS NULL', '(a.item_id IS NULL OR i.owner_user_id=$1)'];
    const params: unknown[] = [filter.principalId];
    const add = (sql: string, value: unknown) => { params.push(value); conditions.push(sql.replace('?', `$${ params.length }`)); };
    if (typeof filter.item === 'string') {
      add('a.item_id=?::uuid', filter.item);
    }
    const agentEvent = `(a.action IN ('vault_outbound_request','agent_credential_broker_use','agent_credential_use') OR a.metadata ? 'agentId')`;
    if (filter.actor === 'agent') conditions.push(agentEvent);
    else if (filter.actor === 'human') conditions.push(`NOT ${ agentEvent }`);
    if (filter.blocked === 'true') conditions.push('a.blocked=true');
    if (typeof filter.from === 'string') {
      add('a.created_at>=?::timestamptz', filter.from);
    }
    if (typeof filter.query === 'string') {
      const query = filter.query.trim();
      if (query) {
        params.push(`%${ query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') }%`);
        const search = `$${ params.length }`;
        conditions.push(`(a.action ILIKE ${ search } OR COALESCE(a.pod_id,'') ILIKE ${ search } OR COALESCE(a.item_id::text,'') ILIKE ${ search } OR COALESCE(a.metadata->>'agentId','') ILIKE ${ search } OR COALESCE(a.metadata->>'operation','') ILIKE ${ search } OR COALESCE(a.metadata->>'destination','') ILIKE ${ search })`);
      }
    }
    params.push(filter.window, filter.offset);
    const result = await this.client.query(
      `SELECT a.id,a.item_id,a.action,a.pod_id,a.metadata,a.blocked,a.reason,a.created_at
         FROM audit_log a LEFT JOIN items i ON i.id=a.item_id
        WHERE ${ conditions.join(' AND ') }
        ORDER BY a.created_at DESC,a.id DESC LIMIT $${ params.length - 1 } OFFSET $${ params.length }`, params,
    );
    return result.rows;
  }
}
