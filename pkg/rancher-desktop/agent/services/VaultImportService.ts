import { createHash } from 'node:crypto';

import {
  createUserKey,
  createUserKeyPair,
  deriveLoginHash,
  deriveMasterKey,
  decryptItem,
  encryptItem,
  unwrapUserKey,
  type EncryptedEnvelope,
  type EncryptedItem,
} from '../../../../packages/vault-crypto/src/index';

import { postgresClient } from '../database/PostgresClient';
import { getVaultKeyService } from './VaultKeyService';

const API = 'http://127.0.0.1:30121';
const ACCESS_LEVELS = new Set(['none', 'metadata', 'autofill', 'full']);
const VAULT_PREFIX = '$VAULT$';

interface LegacyRow {
  value_id: number;
  integration_id: string;
  account_id: string;
  property: string;
  value: string;
}
interface VaultItemResponse {
  id: string;
  ciphertext: EncryptedEnvelope;
  encrypted_item_key: EncryptedEnvelope;
}

function itemId(valueId: number): string {
  const hex = createHash('sha256').update(`sulla-legacy-v1:${ valueId }`).digest('hex').slice(0, 32);
  return `${ hex.slice(0, 8) }-${ hex.slice(8, 12) }-5${ hex.slice(13, 16) }-8${ hex.slice(17, 20) }-${ hex.slice(20) }`;
}

function accessLevel(rows: LegacyRow[], integrationId: string, accountId: string): string {
  const row = rows.find(candidate => candidate.integration_id === integrationId && candidate.account_id === accountId && candidate.property === 'vault_llm_access');
  return row?.value ?? 'none';
}

async function request(path: string, init: RequestInit): Promise<any> {
  const response = await fetch(`${ API }${ path }`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`vault request failed (${ response.status })`);
  return body;
}

/**
 * Copy legacy $VAULT$ rows into sulla-vault without changing the legacy DB.
 * The password is used only in this process to derive the new client keys;
 * neither it, the VMK, nor decrypted values cross the HTTP boundary.
 */
export async function importLegacyVault(masterPassword: string): Promise<void> {
  const settings = (await import('@pkg/config/settingsImpl')).getSettings();
  if (!settings.sullaVaultV2Enabled || !masterPassword) return;

  const oldVault = getVaultKeyService();
  if (!oldVault.isUnlocked()) return;

  const rows = await postgresClient.query<LegacyRow>(
    `SELECT value_id, integration_id, account_id, property, value
       FROM integration_values
      WHERE value LIKE $1
      ORDER BY value_id`, [`${ VAULT_PREFIX }%`],
  );
  if (!rows.length) return;

  const master = await deriveMasterKey(masterPassword);
  const candidate = await createUserKey(master.key);
  const pair = await createUserKeyPair(candidate.userKey);
  const kdf = { salt: master.salt, parameters: master.parameters };

  await request('/v1/desktop/bootstrap', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      loginHash: await deriveLoginHash(master.key), publicKey: pair.publicKey,
      encryptedPrivateKey: pair.encryptedPrivateKey, encryptedUserKey: candidate.encryptedUserKey, kdf,
    }),
  });
  const session = await request('/v1/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginHash: await deriveLoginHash(master.key) }),
  });
  const token = session.token as string;
  const userKey = await unwrapUserKey(session.user.encryptedUserKey, master.key);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${ token }` };
  const existing = await request('/v1/items', { headers });
  const imported = new Set((existing.items as VaultItemResponse[]).map(item => item.id));
  let copied = 0;
  let skipped = 0;
  let rejected = 0;

  for (const row of rows) {
    const id = itemId(row.value_id);
    if (imported.has(id)) { skipped++; continue; }
    let plaintext: string;
    try {
      plaintext = oldVault.decrypt(row.value);
    } catch {
      rejected++;
      continue;
    }
    const level = accessLevel(rows, row.integration_id, row.account_id);
    if (!ACCESS_LEVELS.has(level)) {
      rejected++;
      continue;
    }
    const payload = JSON.stringify({
      source: 'integration_values', sourceId: row.value_id,
      integrationId: row.integration_id, accountId: row.account_id,
      property: row.property, value: plaintext, vaultLlmAccess: level,
    });
    const encrypted: EncryptedItem = await encryptItem(payload, userKey, { itemId: id, ownerId: session.user.id });
    await request('/v1/items', {
      method: 'POST', headers,
      body: JSON.stringify({ id, itemType: 'legacy_credential', ciphertext: encrypted.ciphertext, encryptedItemKey: encrypted.encryptedItemKey }),
    });
    copied++;
  }

  // Read-only equality check: decrypt each imported item locally and compare to
  // the still-present legacy ciphertext. Mismatches are counts only.
  const after = await request('/v1/items', { headers });
  let mismatches = 0;
  for (const item of after.items as VaultItemResponse[]) {
    const sourceId = Number(item.id ? rows.find(row => itemId(row.value_id) === item.id)?.value_id : NaN);
    if (!Number.isSafeInteger(sourceId)) continue;
    const legacy = rows.find(row => row.value_id === sourceId);
    if (!legacy) continue;
    try {
      const decoded = JSON.parse(new TextDecoder().decode(await decryptItem({ version: 1, encryptedItemKey: item.encrypted_item_key, ciphertext: item.ciphertext }, userKey, { itemId: item.id, ownerId: session.user.id })));
      if (decoded.value !== oldVault.decrypt(legacy.value)) mismatches++;
    } catch { mismatches++; }
  }
  console.log(`[VaultImport] rows=${ rows.length } copied=${ copied } skipped=${ skipped } rejected=${ rejected } mismatches=${ mismatches }`);
}
