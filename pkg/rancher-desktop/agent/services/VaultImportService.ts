import { createHash } from 'node:crypto';

import { getDesktopVaultClient } from './DesktopVaultClient';
import { getVaultKeyService } from './VaultKeyService';
import {
  agentPolicyFromLegacyLlmAccess,
  decryptItem,
  encryptItem,
  type EncryptedEnvelope,
  type EncryptedItem,
  type VaultItemPlaintext,
} from '../../../../packages/vault-crypto/src/index';
import { postgresClient } from '../database/PostgresClient';

const API = 'http://127.0.0.1:30125';
const VAULT_PREFIX = '$VAULT$';

interface LegacyRow {
  value_id:       number;
  integration_id: string;
  account_id:     string;
  property:       string;
  value:          string;
}
interface VaultItemResponse {
  id:                 string;
  ciphertext:         EncryptedEnvelope;
  encrypted_item_key: EncryptedEnvelope;
}

export function legacyAccountItemId(integrationId: string, accountId: string): string {
  const hex = createHash('sha256').update(`sulla-legacy-account-v2:${ integrationId }:${ accountId }`).digest('hex').slice(0, 32);
  return `${ hex.slice(0, 8) }-${ hex.slice(8, 12) }-5${ hex.slice(13, 16) }-8${ hex.slice(17, 20) }-${ hex.slice(20) }`;
}

async function request(path: string, init: RequestInit): Promise<any> {
  const response = await fetch(`${ API }${ path }`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`vault request failed (${ response.status })`);
  return body;
}

function decryptLegacy(row: LegacyRow, oldVault: ReturnType<typeof getVaultKeyService>): string | null {
  try {
    return row.value.startsWith(VAULT_PREFIX) ? oldVault.decrypt(row.value) : row.value;
  } catch {
    return null;
  }
}

function itemName(integrationId: string, accountId: string, properties: Record<string, string>): string {
  if (properties.account_label) return properties.account_label;
  if (integrationId === 'website' && properties.website_url) {
    try { return new URL(properties.website_url).hostname } catch { /* use account id */ }
  }
  return accountId === 'default' ? integrationId : `${ integrationId } · ${ accountId }`;
}

/**
 * Copy each legacy integration account into one encrypted vault item. Stable IDs make
 * reruns idempotent. The legacy rows are read-only and remain the rollback source.
 */
export async function importLegacyVault(masterPassword: string): Promise<void> {
  const settings = (await import('@pkg/config/settingsImpl')).getSettings();
  if (!settings.experimental.sullaVaultV2Enabled || !masterPassword) return;

  const oldVault = getVaultKeyService();
  if (!oldVault.isUnlocked()) return;
  const client = getDesktopVaultClient();
  if (!client.isUnlocked()) await client.unlock(masterPassword);

  const rows = await postgresClient.query<LegacyRow>(
    `SELECT value_id, integration_id, account_id, property, value
       FROM integration_values
      ORDER BY integration_id, account_id, value_id`, [],
  );
  const grouped = new Map<string, LegacyRow[]>();
  for (const row of rows) {
    const key = `${ row.integration_id }\u0000${ row.account_id }`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  if (!grouped.size) return;

  // The client already owns key derivation and local decryption. Use a short-lived
  // session response only for the import equality proof, never for plaintext transit.
  const bootstrap = await request('/v1/desktop/bootstrap', { method: 'GET' });
  const { deriveMasterKey, deriveLoginHash, unwrapUserKey } = await import('../../../../packages/vault-crypto/src/index');
  const master = await deriveMasterKey(masterPassword, bootstrap.kdf.salt, bootstrap.kdf.parameters);
  const remoteSession = await request('/v1/session', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ loginHash: await deriveLoginHash(master.key) }),
  });
  const userKey = await unwrapUserKey(remoteSession.user.encryptedUserKey, master.key);
  master.key.fill(0);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${ remoteSession.token }` };
  const existing = await request('/v1/items', { headers });
  const imported = new Set((existing.items as VaultItemResponse[]).map(item => item.id));
  let copied = 0;
  let skipped = 0;
  let rejected = 0;

  for (const accountRows of grouped.values()) {
    const { integration_id: integrationId, account_id: accountId } = accountRows[0];
    const id = legacyAccountItemId(integrationId, accountId);
    if (imported.has(id)) { skipped++; continue }
    const properties: Record<string, string> = {};
    let invalid = false;
    for (const row of accountRows) {
      const value = decryptLegacy(row, oldVault);
      if (value === null) { invalid = true; break }
      properties[row.property] = value;
    }
    if (invalid) { rejected++; continue }

    const agentPolicy = agentPolicyFromLegacyLlmAccess(properties.llm_access);
    delete properties.llm_access;
    const isLogin = integrationId === 'website';
    const uri = properties.website_url;
    const secretProperty = ['password', 'api_key', 'bearer_token', 'client_secret', 'token'].find(key => properties[key]);
    const plaintext: VaultItemPlaintext = {
      type:     isLogin ? 'login' : 'apiKey',
      name:     itemName(integrationId, accountId, properties),
      username: properties.username,
      password: secretProperty ? properties[secretProperty] : undefined,
      uris:     uri ? [{ uri, match: 'domain' }] : [],
      fields:   Object.entries(properties)
        .filter(([key]) => !['account_label', 'website_url', 'username', secretProperty].includes(key))
        .map(([name, value]) => ({ name, value, hidden: true })),
      integration: { integrationId, accountId, properties },
      agentPolicy,
    };
    const encrypted: EncryptedItem = await encryptItem(JSON.stringify(plaintext), userKey, { itemId: id, ownerId: remoteSession.user.id });
    await request('/v1/items', {
      method: 'POST',
      headers,
      body:   JSON.stringify({
        id,
        itemType:         plaintext.type,
        ciphertext:       encrypted.ciphertext,
        encryptedItemKey: encrypted.encryptedItemKey,
        agentPolicy,
      }),
    });
    copied++;
  }

  // Compare imported plaintext to legacy data locally. Report counts only.
  const after = await request('/v1/items', { headers });
  let mismatches = 0;
  for (const item of after.items as VaultItemResponse[]) {
    const accountRows = [...grouped.values()].find(group => legacyAccountItemId(group[0].integration_id, group[0].account_id) === item.id);
    if (!accountRows) continue;
    try {
      const decoded = JSON.parse(new TextDecoder().decode(await decryptItem(
        { version: 1, encryptedItemKey: item.encrypted_item_key, ciphertext: item.ciphertext },
        userKey, { itemId: item.id, ownerId: remoteSession.user.id },
      ))) as VaultItemPlaintext;
      for (const row of accountRows.filter(candidate => candidate.property !== 'llm_access')) {
        if (decoded.integration?.properties[row.property] !== decryptLegacy(row, oldVault)) mismatches++;
      }
    } catch { mismatches++ }
  }
  userKey.fill(0);
  console.log(`[VaultImport] accounts=${ grouped.size } copied=${ copied } skipped=${ skipped } rejected=${ rejected } mismatches=${ mismatches }`);
}
