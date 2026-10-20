import { AsyncLocalStorage } from 'node:async_hooks';
export const auditContext = new AsyncLocalStorage();
/** Tag checked-out connections, not the pool: identities cannot leak between requests. */
export function installAuditContext(db) {
    const connect = db.connect.bind(db);
    db.connect = (async () => {
        const client = await connect();
        const context = auditContext.getStore();
        try {
            await client.query("SELECT set_config('sulla.audit_actor',$1,false),set_config('sulla.audit_request_id',$2,false),set_config('sulla.audit_action',$3,false)", [context?.actor ?? 'sulla-files', context?.requestId ?? '', context?.action ?? '']);
        }
        catch (error) {
            client.release(error);
            throw error;
        }
        return client;
    });
    db.query = (async (...args) => {
        const client = await db.connect();
        try {
            return await client.query(...args);
        }
        finally {
            client.release();
        }
    });
}
