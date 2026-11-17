// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { LegacyProfileMigrator } from '../src/profiles/LegacyProfileMigrator.js';
import { PostgresLegacyProfileSourceRepository } from '../src/repositories/PostgresLegacyProfileSourceRepository.js';
import { PostgresLegacyProfileDestinationRepository } from '../src/repositories/PostgresLegacyProfileDestinationRepository.js';
import { LegacyProfileHashRepository } from '../src/repositories/LegacyProfileHashRepository.js';
import { ProfileCatalogEntry } from '@sulla/vault-profiles';
import { VaultMigrator } from '../src/database/VaultMigrator.js';

// Mirrors node-pg: no params means simple protocol (multi-statement allowed, last result returned);
// with params means a single extended-protocol statement.
async function pgliteQuery(db: PGlite, text: string, params?: unknown[]): Promise<any> {
  if (!params || params.length === 0) {
    const results: any[] = await db.exec(text);
    const last: any = results[results.length - 1] ?? { rows: [], affectedRows: 0, fields: [] };
    return { rows: last.rows ?? [], rowCount: last.affectedRows ?? (last.rows ?? []).length, fields: last.fields ?? [] };
  }
  const res: any = await db.query(text, params);
  return { rows: res.rows ?? [], rowCount: res.affectedRows ?? (res.rows ?? []).length, fields: res.fields ?? [] };
}

class PglitePool {
  constructor(readonly db: PGlite) {}
  async query(...args: any[]) { return pgliteQuery(this.db, args[0], args[1]); }
  async connect() { return { query: async (...args: any[]) => pgliteQuery(this.db, args[0], args[1]), release() {} } as any; }
}

describe('legacy profile migration on PostgreSQL-compatible databases', () => {
  it('copies table contents exactly, preserves sequences, json and bytea', async () => {
    // risk: data accuracy, encrypted bytes, FK integrity and future serial inserts
    const legacy = new PGlite({ extensions: { pgcrypto } }); const profile = new PGlite({ extensions: { pgcrypto } });
    const sourcePool = new PglitePool(legacy); const destinationPool = new PglitePool(profile);
    const migrationPath = new URL('../migrations', import.meta.url).pathname;
    await new VaultMigrator(new URL('../src/database', import.meta.url).pathname).migrate(sourcePool as any);
    await legacy.query("INSERT INTO users(email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf) VALUES ('x@x.test',decode('01','hex'),decode('02','hex'),'pk','{}','{}','{\"cloudUserId\":\"cloud-x\"}')");
    const user = await legacy.query<{id:string}>("SELECT id FROM users");
    await legacy.query("INSERT INTO items(owner_user_id,item_type,ciphertext,encrypted_item_key) SELECT id,'login','[1,2,3]'::jsonb,'{}'::jsonb FROM users");
    await legacy.query("INSERT INTO audit_log(actor_user_id,action,metadata) SELECT id,'migration-test','[\"a\",\"b\"]'::jsonb FROM users");
    for(let i=0;i<501;i++) await legacy.query("INSERT INTO items(owner_user_id,item_type,ciphertext,encrypted_item_key) VALUES ($1,'login',$2::jsonb,'{}'::jsonb)",[user.rows[0].id,JSON.stringify([i])]);
    const source = new PostgresLegacyProfileSourceRepository(sourcePool as any);
    const destination = new PostgresLegacyProfileDestinationRepository((id:any)=>destinationPool as any, destinationPool as any, migrationPath, undefined, 250);
    const ports:any={ backup:{createSnapshot:async()=>{}}, source, destination,
      catalog:{entries:async()=>[],setState:async()=>{},completeAndActivate:async()=>{}}, mapping:{get:async()=>'',set:async()=>{}}, hash:new LegacyProfileHashRepository() };
    const provisioner:any={provision:async(_entry:ProfileCatalogEntry)=>{}};
    const migrator=new LegacyProfileMigrator(true,provisioner,ports);
    await expect(migrator.migrate(true)).resolves.toBeInstanceOf(ProfileCatalogEntry);
    const a=await legacy.query('SELECT * FROM users'); const b=await profile.query('SELECT * FROM users');
    expect(ports.hash.digest(a.rows as any)).toBe(ports.hash.digest(b.rows as any));
    const inserted=await profile.query("INSERT INTO audit_log(actor_user_id,action,metadata) SELECT id,'after-copy','{}'::jsonb FROM users RETURNING id");
    expect(inserted.rows[0].id).toBeGreaterThan(1);
    const json=await profile.query("SELECT metadata FROM audit_log WHERE action='migration-test'");
    expect(json.rows[0].metadata).toEqual(['a','b']);
    expect((await profile.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_user_id=(SELECT id FROM users WHERE email='x@x.test') AND action='migration-test'")).rows[0].n).toBe(1);
    const bytes=await profile.query("SELECT login_hash_salt FROM users"); expect(Buffer.from(bytes.rows[0].login_hash_salt).toString('hex')).toBe('01');
    expect((await profile.query('SELECT count(*)::int AS n FROM items')).rows[0].n).toBe(502);
    await legacy.close(); await profile.close();
  });
});
