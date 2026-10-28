// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHmac } from 'node:crypto';

import { makeLoginVerifier } from './auth.js';

import type { AccountsContext } from './accountsIdentity.js';
import type { Database } from './db.js';

export type AccountsOnboardingStatus = 'initialize-owner' | 'initialize-member' | 'request-member' | 'pending' | 'ready';

export interface AccountsVaultMaterial {
  loginHash?:            string;
  publicKey?:            string;
  encryptedPrivateKey?: Record<string, unknown>;
  encryptedUserKey?:    Record<string, unknown>;
  kdf?:                 Record<string, unknown>;
  encryptedOrgName?:   Record<string, unknown>;
  wrappedOrgKey?:      Record<string, unknown>;
}

export class AccountsOnboardingError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'AccountsOnboardingError';
  }
}

function opaqueEmail(jwtSecret: string, context: AccountsContext): string {
  const digest = createHmac('sha256', jwtSecret)
    .update('sulla:vault:accounts-identity:v1\0')
    .update(context.issuer)
    .update('\0')
    .update(context.subject)
    .digest('base64url');
  return `accounts-${ digest }@identity.invalid`;
}

export async function accountsOnboardingStatus(
  db: Pick<Database, 'query'>,
  context: AccountsContext,
): Promise<AccountsOnboardingStatus> {
  const identity = await db.query<{ user_id: string; status: 'pending' | 'confirmed' | null }>(
    `SELECT ai.user_id, om.status
       FROM accounts_identities ai
       LEFT JOIN org_members om ON om.user_id=ai.user_id AND om.org_id=$3
      WHERE ai.issuer=$1 AND ai.subject=$2`,
    [context.issuer, context.subject, context.organizationId],
  );
  if (identity.rows[0]?.status === 'confirmed') return 'ready';
  if (identity.rows[0]?.status === 'pending') return 'pending';
  const organization = await db.query('SELECT 1 FROM orgs WHERE id=$1', [context.organizationId]);
  if (organization.rowCount) return identity.rows[0]?.user_id ? 'request-member' : 'initialize-member';
  if (identity.rows[0]?.user_id) {
    throw new AccountsOnboardingError(409, 'This Vault identity is already linked and cannot initialize another organization');
  }
  if (!context.roles.includes('owner')) {
    throw new AccountsOnboardingError(403, 'Only an Accounts organization owner can initialize its Vault');
  }
  return 'initialize-owner';
}

export async function initializeAccountsOnboarding(
  db: Pick<Database, 'connect'>,
  jwtSecret: string,
  context: AccountsContext,
  material: AccountsVaultMaterial,
): Promise<{ status: 'pending' | 'ready'; created: boolean }> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)), pg_advisory_xact_lock(hashtext($2))", [
      `vault-accounts-identity:${ context.issuer }:${ context.subject }`,
      `vault-accounts-org:${ context.organizationId }`,
    ]);

    const linked = await client.query<{ user_id: string }>(
      'SELECT user_id FROM accounts_identities WHERE issuer=$1 AND subject=$2',
      [context.issuer, context.subject],
    );
    let userId = linked.rows[0]?.user_id;
    let createdUser = false;
    if (!userId) {
      if (!material.loginHash || !material.publicKey || !material.encryptedPrivateKey || !material.encryptedUserKey || !material.kdf) {
        throw new AccountsOnboardingError(400, 'Browser-encrypted Vault identity material is required');
      }
      const { salt, verifier } = makeLoginVerifier(material.loginHash);
      const user = await client.query<{ id: string }>(
        `INSERT INTO users(email,display_name,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [opaqueEmail(jwtSecret, context), 'Accounts member', salt, verifier, material.publicKey,
          material.encryptedPrivateKey, material.encryptedUserKey, material.kdf],
      );
      userId = user.rows[0].id;
      await client.query(
        'INSERT INTO accounts_identities(issuer,subject,user_id) VALUES ($1,$2,$3)',
        [context.issuer, context.subject, userId],
      );
      createdUser = true;
    }

    const organization = await client.query('SELECT 1 FROM orgs WHERE id=$1', [context.organizationId]);
    if (!organization.rowCount) {
      if (!context.roles.includes('owner')) {
        throw new AccountsOnboardingError(403, 'Only an Accounts organization owner can initialize its Vault');
      }
      if (!material.encryptedOrgName || !material.wrappedOrgKey) {
        throw new AccountsOnboardingError(400, 'Encrypted organization material is required');
      }
      await client.query(
        'INSERT INTO orgs(id,encrypted_name,created_by) VALUES ($1,$2,$3)',
        [context.organizationId, material.encryptedOrgName, userId],
      );
      await client.query(
        `INSERT INTO org_members(org_id,user_id,role,wrapped_org_key,status)
         VALUES ($1,$2,'owner',$3,'confirmed')`,
        [context.organizationId, userId, material.wrappedOrgKey],
      );
      await client.query(
        `INSERT INTO audit_log(actor_user_id,org_id,action,metadata)
         VALUES ($1,$2,'accounts_owner_initialized','{}'::jsonb)`,
        [userId, context.organizationId],
      );
      await client.query('COMMIT');
      return { status: 'ready', created: true };
    }

    const membership = await client.query<{ status: 'pending' | 'confirmed' }>(
      'SELECT status FROM org_members WHERE org_id=$1 AND user_id=$2',
      [context.organizationId, userId],
    );
    if (membership.rows[0]?.status === 'confirmed') {
      await client.query('COMMIT');
      return { status: 'ready', created: createdUser };
    }
    if (!membership.rowCount) {
      await client.query(
        `INSERT INTO org_members(org_id,user_id,role,wrapped_org_key,status)
         VALUES ($1,$2,'member',NULL,'pending')`,
        [context.organizationId, userId],
      );
      await client.query(
        `INSERT INTO audit_log(actor_user_id,org_id,action,metadata)
         VALUES ($1,$2,'accounts_membership_requested','{}'::jsonb)`,
        [userId, context.organizationId],
      );
    }
    await client.query('COMMIT');
    return { status: 'pending', created: createdUser };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
