import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import test from 'node:test';

import { SharesService } from './shares.js';

function encodedPassword(password:string) {
  const salt = Buffer.from('synthetic-share-salt');
  return `${ salt.toString('base64url') }:${ scryptSync(password, salt, 32).toString('base64url') }`;
}

function service(row?:Record<string, unknown>) {
  const writes:string[] = [];
  const db = { query: async(sql:string) => { if (sql.startsWith('SELECT * FROM file_share_links WHERE id=$1')) return { rows: row ? [row] : [] }; writes.push(sql); return { rows: [], rowCount: 1 } } };
  return { shares: new SharesService(db as any, { mode: 'desktop' } as any, {} as any), writes };
}

async function status(operation:()=>Promise<unknown>) { try { await operation(); return 200 } catch (error:any) { return error.status } }

test('share authorization fails closed for unknown, revoked, expired, password, and download policy boundaries', async() => {
  assert.equal(await status(() => service().shares.authorize('missing', {})), 404);
  assert.equal(await status(() => service({ id: 'revoked', revoked_at: new Date().toISOString() }).shares.authorize('revoked', {})), 404);
  assert.equal(await status(() => service({ id: 'expired', expires_at: new Date(Date.now() - 1_000).toISOString() }).shares.authorize('expired', {})), 404);

  const protectedRow = { id: 'protected', display_name: 'Synthetic file', mime: 'text/plain', target_type: 'file', access_mode: 'view', password_protected: true, password_hash: encodedPassword('correct horse battery staple'), display_sharer_name: true };
  assert.equal(await status(() => service(protectedRow).shares.authorize('protected', {})), 401);
  assert.equal(await status(() => service(protectedRow).shares.authorize('protected', { password: 'wrong password' })), 401);
  assert.equal(await status(() => service(protectedRow).shares.authorize('protected', { password: 'correct horse battery staple', wantsDownload: true })), 403);

  const allowed = service({ ...protectedRow, access_mode: 'download' });
  assert.equal(await status(() => allowed.shares.authorize('protected', { password: 'correct horse battery staple', wantsDownload: true })), 200);
  assert.equal(allowed.writes.some(sql => sql.includes('view_count=view_count+1')), true);
  assert.equal(allowed.writes.some(sql => sql.includes('file_share_events')), true);
});
