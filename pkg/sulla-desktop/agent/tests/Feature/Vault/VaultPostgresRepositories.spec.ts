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
import { SYNC_SCHEMA_SQL } from '../../../../../../services/sulla-vault/src/browserEnvelope/schema';
import { PostgresRewrapHistoryRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresRewrapHistoryRepository';
import { PostgresVaultAuditLogRepository, PostgresVaultItemRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresVaultItemRepositories';
import { PostgresIntegrationStateRepository, PostgresVaultMigrationRepository, PostgresVaultRecoveryRepository, PostgresVaultSyncStateRepository, PostgresVaultUserRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresVaultAuthorityRepositories';
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
    if (this.pglite) await this.pglite.exec(SYNC_SCHEMA_SQL);
    else await this.db.query(SYNC_SCHEMA_SQL);
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
}
const database=new VaultDatabase(), fx=new Fixture();
beforeAll(async()=>{await database.setup(); await database.seed(fx.user,fx.org)}); afterAll(()=>database.close());
describe.sequential('vault Postgres repositories',()=>{
  it('isolates active items, enforces revision CAS, and records agent audit ownership',async()=>{ // risk: tenant isolation and concurrent data loss
    const otherUser='10000000-0000-4000-8000-000000000002';
    await database.seed(otherUser,'20000000-0000-4000-8000-000000000004');
    const items=new PostgresVaultItemRepository(database.db), audit=new PostgresVaultAuditLogRepository(database.db);
    const active='40000000-0000-4000-8000-000000000001', deleted='40000000-0000-4000-8000-000000000002', foreign='40000000-0000-4000-8000-000000000003';
    const policy={mode:'agents',level:'autofill',agents:['agent-one'],sites:[]};
    await items.insertAgentIntegrationItem([active,fx.user,'apiKey',{ciphertext:'active'},{ciphertext:'key'},policy,'github/main']);
    await items.insertAgentIntegrationItem([deleted,fx.user,'apiKey',{ciphertext:'deleted'},{ciphertext:'key'},policy,'github/deleted']);
    await items.insertAgentIntegrationItem([foreign,otherUser,'apiKey',{ciphertext:'foreign'},{ciphertext:'key'},policy,'github/foreign']);
    await items.softDeleteOwnedIfRevision([deleted,fx.user,1]);
    const visible=await items.listOwnedActiveForImport<{id:string}>([fx.user]);
    expect(visible.rows.map(row=>row.id)).toContain(active);
    expect(visible.rows.map(row=>row.id)).not.toContain(deleted);
    expect(visible.rows.map(row=>row.id)).not.toContain(foreign);
    await expect(items.updateOwnedCiphertextIfRevision([{ciphertext:'next'},{ciphertext:'next-key'},active,fx.user,1])).resolves.toMatchObject({rowCount:1});
    await expect(items.updateOwnedCiphertextIfRevision([{ciphertext:'stale'},{ciphertext:'stale-key'},active,fx.user,1])).resolves.toMatchObject({rowCount:0});
    await audit.recordAgentCreated([fx.user,active,'pod-one',{agentId:'agent-one'}]);
    await expect(audit.wasCreatedByAgentForUpdate([active,'agent-one'])).resolves.toMatchObject({rowCount:1});
    await expect(audit.wasCreatedByAgentForUpdate([active,'agent-two'])).resolves.toMatchObject({rowCount:0});
    const recorded=await database.db.query<{actor_user_id:string;item_id:string;action:string;pod_id:string;metadata:{agentId:string};blocked:boolean}>('SELECT actor_user_id,item_id,action,pod_id,metadata,blocked FROM audit_log WHERE item_id=$1',[active]);
    expect(recorded.rows).toEqual([{actor_user_id:fx.user,item_id:active,action:'agent_vault_item_created',pod_id:'pod-one',metadata:{agentId:'agent-one'},blocked:false}]);
  });

  it('preserves the current password wrap with its parameterized reason',async()=>{ // risk: recovery data loss
    const repository=new PostgresRewrapHistoryRepository(database.db);
    await repository.preserveCurrentPasswordWrap(fx.user,'password_change');
    await repository.preservePasswordWrap({user_id:fx.user,login_hash_salt:Buffer.from('cloud'),login_hash_verifier:Buffer.from('verify'),encrypted_user_key:{ciphertext:'cloud'},kdf:{alg:'test'}},'cloud_rewrap');
    const history=await repository.listPasswordWraps(fx.user);
    expect(history).toHaveLength(2);
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({user_id:fx.user,reason:'password_change',encrypted_user_key:{ciphertext:'key'}}),
      expect.objectContaining({user_id:fx.user,reason:'cloud_rewrap',encrypted_user_key:{ciphertext:'cloud'}}),
    ]));
  });
  it('preserves the current recovery wrap with its parameterized reason',async()=>{ // risk: recovery data loss
    const repository=new PostgresRewrapHistoryRepository(database.db);
    await database.db.query(`INSERT INTO local_vault_recovery(user_id,recovery_salt,recovery_verifier,encrypted_user_key) VALUES ($1,'salt','verifier','{"ciphertext":"recovery"}'::jsonb)`,[fx.user]);
    await expect(repository.preserveCurrentRecoveryWrap(fx.user,'rotation')).resolves.toBe(true);
    await expect(repository.listRecoveryWraps(fx.user)).resolves.toEqual([
      expect.objectContaining({user_id:fx.user,recovery_salt:'salt',recovery_verifier:'verifier',reason:'rotation'}),
    ]);
  });
  it('finds only the active vault user and updates that user password wrap', async()=>{ // risk: disabled-account authentication
    const disabled='10000000-0000-4000-8000-000000000099';
    await database.seed(disabled,'20000000-0000-4000-8000-000000000099');
    await database.db.query('UPDATE users SET disabled_at=now() WHERE id<>$1',[disabled]);
    const users=new PostgresVaultUserRepository(database.db);
    await expect(users.findActive<{id:string}>()).resolves.toMatchObject({rows:[expect.objectContaining({id:disabled})]});
    await database.db.query('UPDATE users SET disabled_at=NULL WHERE id=$1',[fx.user]);
    await database.db.query('UPDATE users SET disabled_at=now() WHERE id=$1',[disabled]);
    await users.updatePassword(fx.user,[Buffer.from('next-salt'),Buffer.from('next-verifier'),{ciphertext:'next-key'},{alg:'next'}]);
    await expect(users.findCredentials<{login_hash_salt:Buffer;kdf:{alg:string}}>(fx.user)).resolves.toMatchObject({rows:[expect.objectContaining({kdf:{alg:'next'}})]});
  });

  it('keeps recovery rows isolated by user during reads and replacement', async()=>{ // risk: cross-user recovery takeover
    const otherUser='10000000-0000-4000-8000-000000000002';
    const recovery=new PostgresVaultRecoveryRepository(database.db);
    await recovery.upsertForRotation([fx.user,'salt-a','verifier-a',{ciphertext:'wrap-a'}]);
    await recovery.upsertForHumanRecovery([otherUser,'salt-b','verifier-b',{ciphertext:'wrap-b'}]);
    await expect(recovery.findForUser<{user_id:string;recovery_salt:string}>(fx.user)).resolves.toMatchObject({rows:[{user_id:fx.user,recovery_salt:'salt-a',recovery_verifier:'verifier-a',encrypted_user_key:{ciphertext:'wrap-a'}}]});
    await recovery.upsertForRotation([fx.user,'salt-next','verifier-next',{ciphertext:'wrap-next'}]);
    await expect(recovery.findForUser<{user_id:string;recovery_salt:string}>(otherUser)).resolves.toMatchObject({rows:[expect.objectContaining({user_id:otherUser,recovery_salt:'salt-b'})]});
  });

  it('persists integration selection, migration bookkeeping, and cloud sync state', async()=>{ // risk: migration replay and sync routing
    const integration=new PostgresIntegrationStateRepository(database.db);
    await integration.upsert(fx.user,'github','primary');
    await integration.upsert(fx.user,'github','secondary');
    await expect(integration.findActive<{active_account_id:string}>(fx.user,'github')).resolves.toMatchObject({rows:[{active_account_id:'secondary'}]});
    const migrationItem='40000000-0000-4000-8000-000000000010';
    await new PostgresVaultItemRepository(database.db).insertAgentIntegrationItem([migrationItem,fx.user,'apiKey',{ciphertext:'migration'},{ciphertext:'key'},{mode:'agents',level:'autofill',agents:[],sites:[]},'legacy/account']);
    const migration=new PostgresVaultMigrationRepository(database.db);
    const batch=await migration.start<{id:string}>('fingerprint-a');
    await migration.addRow(['integration_value',1,'fingerprint-a',migrationItem]);
    await migration.commit(batch.rows[0].id,1,0);
    await expect(migration.findCommitted<{imported_count:number}>('fingerprint-a')).resolves.toMatchObject({rows:[expect.objectContaining({imported_count:1})]});
    const sync=new PostgresVaultSyncStateRepository(database.db);
    await sync.create([fx.user,'50000000-0000-4000-8000-000000000001',3,4,'bundle-sha']);
    await expect(sync.find<{vault_id:string;epoch:number}>(fx.user)).resolves.toMatchObject({rows:[{vault_id:'50000000-0000-4000-8000-000000000001',epoch:3}]});
  });

});
