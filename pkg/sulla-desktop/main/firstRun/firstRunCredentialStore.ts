// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { sullaRuntimeDirectory } from '@pkg/backend/sullaRuntime/artifacts';

import type { PendingCredential } from './pendingCredentials';

interface StoredEnvelope { ciphertext: string; nonce: string }
interface StoredRow { integration_id: string; account_id: string; encrypted_payload: StoredEnvelope; key_id: string }

const KEY_FILE_NAME = 'first-run-credentials.key';

export function firstRunCredentialKeyPath(): string {
  return path.join(sullaRuntimeDirectory(), 'secrets', KEY_FILE_NAME);
}

function loadOrCreateKey(): { key: Buffer; keyId: string } {
  const keyPath = firstRunCredentialKeyPath();
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  let key: Buffer;
  try {
    key = fs.readFileSync(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    key = crypto.randomBytes(32);
    try {
      fs.writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      key = fs.readFileSync(keyPath);
    }
  }
  if (key.length !== 32) throw new Error('First-run credential encryption key has an invalid length');
  fs.chmodSync(keyPath, 0o600);
  return { key, keyId: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) };
}

function seal(entry: PendingCredential): { envelope: StoredEnvelope; keyId: string } {
  const { key, keyId } = loadOrCreateKey();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ values: entry.values, activate: entry.activate }), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    keyId,
    envelope: { ciphertext: ciphertext.toString('base64'), nonce: nonce.toString('base64') },
  };
}

function open(row: StoredRow): PendingCredential {
  const { key, keyId } = loadOrCreateKey();
  if (row.key_id !== keyId) throw new Error(`First-run credential key ${ row.key_id } is unavailable`);
  const payload = row.encrypted_payload;
  const sealed = Buffer.from(payload.ciphertext, 'base64');
  if (sealed.length < 16) throw new Error('First-run credential ciphertext is truncated');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.nonce, 'base64'));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plaintext = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  const parsed = JSON.parse(plaintext.toString('utf8')) as Pick<PendingCredential, 'values' | 'activate'>;
  return { integrationId: row.integration_id, accountId: row.account_id, values: parsed.values, activate: parsed.activate };
}

export async function storeFirstRunCredential(entry: PendingCredential): Promise<void> {
  const { envelope, keyId } = seal(entry);
  await postgresClient.query(`
    INSERT INTO first_run_credentials (integration_id, account_id, encrypted_payload, key_id)
    VALUES ($1, $2, $3::jsonb, $4)
    ON CONFLICT (integration_id, account_id) DO UPDATE
      SET encrypted_payload = EXCLUDED.encrypted_payload, key_id = EXCLUDED.key_id, created_at = CURRENT_TIMESTAMP
  `, [entry.integrationId, entry.accountId, JSON.stringify(envelope), keyId]);
}

export async function loadFirstRunCredentials(): Promise<PendingCredential[]> {
  const rows = await postgresClient.query<StoredRow>(`
    SELECT integration_id, account_id, encrypted_payload, key_id FROM first_run_credentials ORDER BY created_at
  `);
  return rows.map(open);
}

export async function deleteFirstRunCredential(integrationId: string, accountId: string): Promise<void> {
  await postgresClient.query('DELETE FROM first_run_credentials WHERE integration_id = $1 AND account_id = $2', [integrationId, accountId]);
}

export async function deleteFirstRunCredentialsForIntegration(integrationId: string): Promise<void> {
  await postgresClient.query('DELETE FROM first_run_credentials WHERE integration_id = $1', [integrationId]);
}
