import { AsyncLocalStorage } from 'node:async_hooks';

import type pg from 'pg';

export const auditContext = new AsyncLocalStorage<{actor:string;requestId:string;action?:string}>();

/** Tag checked-out connections, not the pool: identities cannot leak between requests. */
export function installAuditContext(db:pg.Pool):void {
  const connect = db.connect.bind(db);
  db.connect = (async() => {
    const client = await connect();
    const context = auditContext.getStore();
    try { await client.query("SELECT set_config('sulla.audit_actor',$1,false),set_config('sulla.audit_request_id',$2,false),set_config('sulla.audit_action',$3,false)",
      [context?.actor ?? 'sulla-files', context?.requestId ?? '', context?.action ?? '']);
    } catch(error) {client.release(error as Error);throw error}
    return client;
  }) as typeof db.connect;
  db.query = (async(...args:any[]) => {
    const client = await db.connect();
    try { return await (client.query as any)(...args) } finally { client.release() }
  }) as typeof db.query;
}
