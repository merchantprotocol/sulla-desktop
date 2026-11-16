// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AsyncLocalStorage } from 'node:async_hooks';

import { AuditSessionRepository } from './Repositories/AuditSessionRepository.js';

import type pg from 'pg';

export interface AuditContextValue { actor:string; requestId:string; action?:string }

export const auditContext = new AsyncLocalStorage<AuditContextValue>();

/** Tag checked-out connections, not the pool: identities cannot leak between requests. */
export class PoolAuditContext {
  constructor(
    private readonly db:pg.Pool,
    private readonly sessions = new AuditSessionRepository(),
    private readonly context:AsyncLocalStorage<AuditContextValue> = auditContext,
  ) {}

  install():void {
    const db = this.db;
    const connect = db.connect.bind(db);
    db.connect = (async() => {
      const client = await connect();
      const context = this.context.getStore();
      try {
        await this.sessions.tag(client, { actor: context?.actor ?? 'sulla-files', requestId: context?.requestId ?? '', action: context?.action ?? '' });
      } catch (error) { client.release(error as Error); throw error }
      return client;
    }) as typeof db.connect;
    db.query = (async(...args:any[]) => {
      const client = await db.connect();
      try { return await (client.query as any)(...args) } finally { client.release() }
    }) as typeof db.query;
  }
}

/** Delegating shim for index.ts. */
export function installAuditContext(db:pg.Pool):void {
  new PoolAuditContext(db).install();
}
