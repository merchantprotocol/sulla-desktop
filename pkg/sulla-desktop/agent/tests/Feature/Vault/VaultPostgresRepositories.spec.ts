// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../../../../services/sulla-vault/src/db';
import type { SyncBundle, SyncHead, SyncRecord } from '../../../../../../services/sulla-vault/src/browserEnvelope/envelope';
import { PostgresRewrapHistoryRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresRewrapHistoryRepository';
import { PostgresVaultBundleRepository, PostgresVaultHeadRepository, PostgresVaultRecordRepository } from '../../../../../../services/sulla-vault/src/repositories/postgresVaultRepositories';
const { Pool } = pg;
class EmbeddedClient {
  constructor(private readonly db: PGlite) {}
  async query<T>(sql: string, values?: unknown[]) { const r = await this.db.query<T>(sql, values) as { rows: T[]; affectedRows?: number }; return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  release() {}
}
class VaultDatabase {
  private pool: pg.Pool | null = null; private pglite: PGlite | null = null; private schema = ''; private database: Database | null = null;
  async setup() {
    const url = process.env.SULLA_TEST_DATABASE_URL;
    if (url) { this.schema = `vault_repo_${randomUUID().replaceAll('-','')}`; this.pool = new Pool({ connectionString: url, options: `-csearch_path=${this.schema},public` }); await this.pool.query(`CREATE SCHEMA "${this.schema}"`); this.database = this.pool; }
    else { this.pglite = new PGlite(); const client = new EmbeddedClient(this.pglite); this.database = Object.assign(client, { connect: async() => client }) as unknown as Database; }
    const dir = resolve(process.cwd(), 'services/sulla-vault/migrations');
    for (const file of (await readdir(dir)).filter(f => /^\d{3}_.+\.sql$/.test(f)).sort()) { let sql = await readFile(resolve(dir,file),'utf8'); if (this.pglite) { sql = sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''); await this.pglite.exec(sql); } else await this.db.query(sql); }
  }
  get db(): Database { if (!this.database) throw new Error('database not initialized'); return this.database; }
  async seed(userId: string, orgId: string) {
    await this.db.query(`INSERT INTO users(id,email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf) VALUES ($1,$2,$3,$4,'pk','{}'::jsonb,'{"ciphertext":"key"}'::jsonb,'{"alg":"test"}'::jsonb)`,[userId,`${userId}@example.test`,Buffer.from('salt'),Buffer.from('verifier')]);
    await this.db.query(`INSERT INTO orgs(id,encrypted_name,created_by) VALUES ($1,'{}'::jsonb,$2)`,[orgId,userId]);
  }
  async close() { if (this.pool) { await this.pool.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`); await this.pool.end(); } await this.pglite?.close(); }
}
class Fixture {
  user='10000000-0000-4000-8000-000000000001'; org='20000000-0000-4000-8000-000000000001'; ids=['30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000003'];
  bundle(vaultId:string,g=1):SyncBundle { const e={version:1 as const,algorithm:'xchacha20-poly1305' as const,nonce:'A'.repeat(32),ciphertext:'B'.repeat(22)}; return {format:'sulla-vault-sync-bundle',v:1,vaultId,vaultUserId:this.user,epoch:1,bundleGeneration:g,kdf:{alg:'argon2id13',salt:'C'.repeat(22),memoryBytes:67108864,ops:2},encryptedUserKey:e,publicKey:'D'.repeat(43),encryptedPrivateKey:e,mac:'E'.repeat(43)}; }
  head(vaultId:string,seq:number,prev=''):SyncHead { return {format:'sulla-vault-sync-head',v:1,vaultId,scope:'personal',seq,stateHash:'F'.repeat(43),prevHeadMac:prev,mac:String(seq).repeat(43).slice(0,43)}; }
  record(vaultId:string,id:string,g=1):SyncRecord { return {format:'sulla-vault-sync-record',v:1,vaultId,scope:'personal',kind:'item',id,generation:g,deleted:true,mac:'G'.repeat(43)}; }
}
const database=new VaultDatabase(), fx=new Fixture();
beforeAll(async()=>{await database.setup(); await database.seed(fx.user,fx.org)}); afterAll(()=>database.close());
describe.sequential('vault Postgres repositories',()=>{
  it('writes and reads bundle, head, and record data',async()=>{ // risk: data accuracy
    const bundles=new PostgresVaultBundleRepository(database.db), vault=await bundles.findVaultId(fx.org), records=fx.ids.slice(0,2).map(id=>fx.record(vault,id)), head=fx.head(vault,1);
    await expect(bundles.createPersonalVault({userId:fx.user,orgId:fx.org,role:'owner'},vault,{bundle:fx.bundle(vault),head,records})).resolves.toEqual({ok:true});
    await expect(bundles.find(vault,fx.user)).resolves.toMatchObject({epoch:1,bundle_generation:1,bundle:fx.bundle(vault)});
    await expect(new PostgresVaultHeadRepository(database.db).find(vault,fx.user)).resolves.toEqual({seq:1,head});
    await expect(new PostgresVaultRecordRepository(database.db).list(vault,fx.user,0,null,10)).resolves.toEqual({head,records,nextCursor:null});
  });
  it('CAS advances once and rejects a stale expected head',async()=>{ // risk: concurrent data loss
    const bundles=new PostgresVaultBundleRepository(database.db), vault=await bundles.findVaultId(fx.org), repo=new PostgresVaultRecordRepository(database.db), current=await new PostgresVaultHeadRepository(database.db).find(vault,fx.user), record=fx.record(vault,fx.ids[0],2), head=fx.head(vault,2,current!.head.mac), body={scope:'personal',expectedHeadSeq:1,writes:[{id:record.id,baseGeneration:1,record}],head};
    await expect(repo.commit(vault,{scope:'personal',scopeOwner:fx.user,writable:true},body)).resolves.toEqual({ok:true,seq:2,written:1});
    await expect(repo.commit(vault,{scope:'personal',scopeOwner:fx.user,writable:true},body)).resolves.toEqual({ok:false,error:'head_stale',headSeq:2});
  });
  it('pages in ascending sequence/UUID order at the exact limit',async()=>{ // risk: cursor skips
    const org='20000000-0000-4000-8000-000000000002'; await database.db.query(`INSERT INTO orgs(id,encrypted_name,created_by) VALUES ($1,'{}'::jsonb,$2)`,[org,fx.user]); const bundles=new PostgresVaultBundleRepository(database.db),vault=await bundles.findVaultId(org),records=[fx.ids[2],fx.ids[0],fx.ids[1]].map(id=>fx.record(vault,id)); await bundles.createPersonalVault({userId:fx.user,orgId:org,role:'owner'},vault,{bundle:fx.bundle(vault),head:fx.head(vault,1),records}); const repo=new PostgresVaultRecordRepository(database.db),first=await repo.list(vault,fx.user,0,null,2); expect(first.records.map(r=>r.id)).toEqual(fx.ids.slice(0,2)); expect(first.nextCursor).toBe(`1:${fx.ids[1]}`); expect((await repo.list(vault,fx.user,0,{seq:1,id:fx.ids[1]},2)).records.map(r=>r.id)).toEqual([fx.ids[2]]);
  });
  it('rolls back bundle and head when a record insert fails',async()=>{ // risk: atomicity
    const org='20000000-0000-4000-8000-000000000003'; await database.db.query(`INSERT INTO orgs(id,encrypted_name,created_by) VALUES ($1,'{}'::jsonb,$2)`,[org,fx.user]); const bundles=new PostgresVaultBundleRepository(database.db),vault=await bundles.findVaultId(org),invalid={...fx.record(vault,fx.ids[0]),kind:'invalid'} as unknown as SyncRecord; await expect(bundles.createPersonalVault({userId:fx.user,orgId:org,role:'owner'},vault,{bundle:fx.bundle(vault),head:fx.head(vault,1),records:[invalid]})).rejects.toThrow(); await expect(bundles.find(vault,fx.user)).resolves.toBeNull(); await expect(new PostgresVaultHeadRepository(database.db).find(vault,fx.user)).resolves.toBeNull();
  });
  it('inserts and reads password and recovery history',async()=>{ // risk: recovery data loss
    const repo=new PostgresRewrapHistoryRepository(database.db); await repo.preserveCurrentPasswordWrap(fx.user,'password_change'); await repo.preservePasswordWrap({user_id:fx.user,login_hash_salt:Buffer.from('cloud'),login_hash_verifier:Buffer.from('verify'),encrypted_user_key:{ciphertext:'cloud'},kdf:{alg:'test'}},'cloud_rewrap'); await database.db.query(`INSERT INTO local_vault_recovery(user_id,recovery_salt,recovery_verifier,encrypted_user_key) VALUES ($1,'salt','verifier','{"ciphertext":"recovery"}'::jsonb)`,[fx.user]); await expect(repo.preserveCurrentRecoveryWrap(fx.user,'rotation')).resolves.toBe(true); const wraps=await repo.listPasswordWraps(fx.user); expect(wraps).toHaveLength(2); expect(new Set(wraps.map(r=>r.reason))).toEqual(new Set(['password_change','cloud_rewrap'])); await expect(repo.listRecoveryWraps(fx.user)).resolves.toEqual([expect.objectContaining({user_id:fx.user,recovery_salt:'salt',reason:'rotation'})]);
  });
});
