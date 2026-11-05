// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { QueryResult, QueryResultRow } from 'pg';
import type { Database, Queryable } from '../db.js';

type PasswordUpdateValues = [Buffer, Buffer, unknown, unknown];
type UserCreateValues = [Buffer, Buffer, string, unknown, unknown, unknown];
type UserCreateWithIdValues = [string, Buffer, Buffer, string, unknown, unknown, unknown];
type RecoveryValues = [string, string, string, unknown];
type MigrationRowValues = [string, number, string, string];
type SyncStateValues = [string, string, number, number, string];

export class PostgresVaultUserRepository {
  constructor(private readonly db: Database) {}

  findActive<T extends QueryResultRow = QueryResultRow>(client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>('SELECT id,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key FROM users WHERE disabled_at IS NULL LIMIT 1');
  }

  findActiveKdf<T extends QueryResultRow = QueryResultRow>(client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>('SELECT kdf FROM users WHERE disabled_at IS NULL LIMIT 1');
  }

  findActiveOwner<T extends QueryResultRow = QueryResultRow>(client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>('SELECT id,kdf FROM users WHERE disabled_at IS NULL LIMIT 1');
  }

  existsActive(client: Queryable = this.db): Promise<QueryResult> {
    return client.query('SELECT 1 FROM users WHERE disabled_at IS NULL LIMIT 1');
  }

  exists(client: Queryable = this.db): Promise<QueryResult> {
    return client.query('SELECT 1 FROM users LIMIT 1');
  }

  findById<T extends QueryResultRow = QueryResultRow>(userId: string, client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>('SELECT id,email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf FROM users WHERE id=$1', [userId]);
  }

  findCredentials<T extends QueryResultRow = QueryResultRow>(userId: string, client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>('SELECT login_hash_salt,login_hash_verifier,kdf FROM users WHERE id=$1', [userId]);
  }

  updateKdf(userId: string, kdf: unknown, client: Queryable = this.db): Promise<QueryResult> {
    return client.query('UPDATE users SET kdf=$1,updated_at=now() WHERE id=$2', [kdf, userId]);
  }

  updatePassword(userId: string, values: PasswordUpdateValues, client: Queryable = this.db): Promise<QueryResult> {
    return client.query('UPDATE users SET login_hash_salt=$1,login_hash_verifier=$2,encrypted_user_key=$3,kdf=$4,updated_at=now() WHERE id=$5', [...values, userId]);
  }

  create<T extends QueryResultRow = QueryResultRow>(values: UserCreateValues, client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO users(email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf)
             VALUES ('desktop@local.sulla',$1,$2,$3,$4,$5,$6) RETURNING id`, values);
  }

  createWithId(values: UserCreateWithIdValues, client: Queryable = this.db): Promise<QueryResult> {
    return client.query(`INSERT INTO users(id,email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf) VALUES ($1,'desktop@local.sulla',$2,$3,$4,$5,$6,$7)`, values);
  }

  importBackup(values: unknown[], client: Queryable = this.db): Promise<QueryResult> {
    return client.query(
      `INSERT INTO users(id,email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      values,
    );
  }
}

export class PostgresVaultRecoveryRepository {
  constructor(private readonly db: Database) {}

  exists(userId: string, client: Queryable = this.db): Promise<QueryResult> {
    return client.query('SELECT 1 FROM local_vault_recovery WHERE user_id=$1', [userId]);
  }

  findAny<T extends QueryResultRow = QueryResultRow>(client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>('SELECT user_id,recovery_salt,recovery_verifier,encrypted_user_key FROM local_vault_recovery LIMIT 1');
  }

  findForUser<T extends QueryResultRow = QueryResultRow>(userId: string, client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>('SELECT user_id,recovery_salt,recovery_verifier,encrypted_user_key FROM local_vault_recovery WHERE user_id=$1', [userId]);
  }

  upsertForRotation(values: RecoveryValues, client: Queryable = this.db): Promise<QueryResult> {
    return client.query(
      `INSERT INTO local_vault_recovery(user_id,recovery_salt,recovery_verifier,encrypted_user_key)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT(user_id) DO UPDATE SET recovery_salt=$2,recovery_verifier=$3,encrypted_user_key=$4,updated_at=now()`,
      values,
    );
  }

  upsertForHumanRecovery(values: RecoveryValues, client: Queryable = this.db): Promise<QueryResult> {
    return client.query(
      `INSERT INTO local_vault_recovery(user_id,recovery_salt,recovery_verifier,encrypted_user_key)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT(user_id) DO UPDATE SET recovery_salt=$2,recovery_verifier=$3,encrypted_user_key=$4,updated_at=now()`,
      values,
    );
  }

  insert(values: RecoveryValues, client: Queryable = this.db): Promise<QueryResult> {
    return client.query(
      `INSERT INTO local_vault_recovery(user_id,recovery_salt,recovery_verifier,encrypted_user_key) VALUES ($1,$2,$3,$4)`,
      values,
    );
  }
}

export class PostgresIntegrationStateRepository {
  constructor(private readonly db: Database) {}

  findActive<T extends QueryResultRow = QueryResultRow>(ownerUserId: string, integrationId: string, client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>('SELECT active_account_id FROM local_integration_state WHERE owner_user_id=$1 AND integration_id=$2', [ownerUserId, integrationId]);
  }

  upsert(ownerUserId: string, integrationId: string, accountId: string, client: Queryable = this.db): Promise<QueryResult> {
    return client.query(
      `INSERT INTO local_integration_state(owner_user_id,integration_id,active_account_id)
       VALUES ($1,$2,$3)
       ON CONFLICT(owner_user_id,integration_id) DO UPDATE SET active_account_id=$3,updated_at=now()`,
      [ownerUserId, integrationId, accountId],
    );
  }

  upsertImported(ownerUserId: string, integrationId: string, accountId: string, client: Queryable = this.db): Promise<QueryResult> {
    return client.query(
      `INSERT INTO local_integration_state(owner_user_id,integration_id,active_account_id)
           VALUES ($1,$2,$3)
           ON CONFLICT(owner_user_id,integration_id) DO UPDATE SET active_account_id=$3,updated_at=now()`,
      [ownerUserId, integrationId, accountId],
    );
  }

  upsertCloud(ownerUserId: string, integrationId: string, accountId: string, client: Queryable = this.db): Promise<QueryResult> {
    return client.query(
      `INSERT INTO local_integration_state(owner_user_id,integration_id,active_account_id)
         VALUES ($1,$2,$3)
         ON CONFLICT(owner_user_id,integration_id) DO UPDATE SET active_account_id=$3,updated_at=now()`,
      [ownerUserId, integrationId, accountId],
    );
  }

  clear(ownerUserId: string, integrationIds: string[], client: Queryable = this.db): Promise<QueryResult> {
    return client.query('DELETE FROM local_integration_state WHERE owner_user_id=$1 AND integration_id=ANY($2::text[])', [ownerUserId, integrationIds]);
  }
}

export class PostgresVaultMigrationRepository {
  constructor(private readonly db: Database) {}

  hasCommitted(client: Queryable = this.db): Promise<QueryResult> {
    return client.query("SELECT 1 FROM local_vault_migration_batches WHERE status='committed' LIMIT 1");
  }

  findCommitted<T extends QueryResultRow = QueryResultRow>(fingerprint: string, client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>("SELECT id,imported_count,skipped_count FROM local_vault_migration_batches WHERE source_fingerprint=$1 AND status='committed'", [fingerprint]);
  }

  start<T extends QueryResultRow = QueryResultRow>(fingerprint: string, client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO local_vault_migration_batches(source_fingerprint,status)
         VALUES ($1,'running')
         ON CONFLICT(source_fingerprint) DO UPDATE SET status='running',error_code=NULL
         RETURNING id`, [fingerprint]);
  }

  addRow(values: MigrationRowValues, client: Queryable = this.db): Promise<QueryResult> {
    return client.query(`INSERT INTO local_vault_migration_rows(source_kind,source_value_id,source_fingerprint,item_id)
             VALUES ($1,$2,$3,$4) ON CONFLICT(source_kind,source_value_id) DO NOTHING`, values);
  }

  commit(batchId: string, imported: number, skipped: number, client: Queryable = this.db): Promise<QueryResult> {
    return client.query(`UPDATE local_vault_migration_batches SET status='committed',imported_count=$2,skipped_count=$3,committed_at=now()
          WHERE id=$1`, [batchId, imported, skipped]);
  }

  fail(batchId: string, client: Queryable = this.db): Promise<QueryResult> {
    return client.query(`UPDATE local_vault_migration_batches SET status='failed',error_code='migration_failed' WHERE id=$1`, [batchId]);
  }
}

export class PostgresVaultSyncStateRepository {
  constructor(private readonly db: Database) {}

  find<T extends QueryResultRow = QueryResultRow>(ownerUserId: string, client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>('SELECT vault_id,epoch FROM cloud_vault_sync_state WHERE owner_user_id=$1', [ownerUserId]);
  }

  create(values: SyncStateValues, client: Queryable = this.db): Promise<QueryResult> {
    return client.query(`INSERT INTO cloud_vault_sync_state(owner_user_id,vault_id,epoch,bundle_generation,head_seq,head_mac,bundle_sha,last_pull_at) VALUES ($1,$2,$3,$4,0,'',$5,now())`, values);
  }
}

export class PostgresLegacyCredentialRepository {
  async list(connection: Queryable): Promise<QueryResult> {
    return connection.query(`SELECT 'integration_value'::text AS source_kind,value_id,integration_id,account_id,property,value,is_default,created_at,updated_at
             FROM integration_values
           UNION ALL
           SELECT 'oauth_token', token_id * 10 + property_index, integration_id, account_id, property, value, false, created_at, updated_at
             FROM oauth_tokens
             CROSS JOIN LATERAL (VALUES
               (1,'access_token',access_token),
               (2,'refresh_token',refresh_token),
               (3,'token_type',token_type),
               (4,'scope',scope),
               (5,'expires_at',expires_at::text),
               (6,'provider_id',provider_id)
             ) AS oauth_properties(property_index,property,value)
            WHERE value IS NOT NULL
            ORDER BY source_kind,value_id`);
  }
}
