import {
  decryptItemText,
  deriveLoginHash,
  deriveMasterKey,
  encryptItem,
  unwrapUserKey,
  type AgentPolicy,
  type EncryptedItem,
  type VaultItemPlaintext,
} from '../../../../packages/vault-crypto/src/index';

const API = 'http://127.0.0.1:30121';

interface RemoteItem {
  id: string;
  item_type: string;
  ciphertext: EncryptedItem['ciphertext'];
  encrypted_item_key: EncryptedItem['encryptedItemKey'];
  agent_wrapped_item_key?: EncryptedItem['agentWrappedItemKey'];
  revision: number;
  created_at: string;
  updated_at: string;
  agent_policy?: AgentPolicy;
}

interface Session { token: string; userId: string; userKey: Uint8Array }

let session: Session | null = null;

async function request(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${ API }${ path }`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Vault request failed (${ response.status })`);
  return body;
}

function headers(): Record<string, string> {
  if (!session) throw new Error('Vault is locked');
  return { 'content-type': 'application/json', authorization: `Bearer ${ session.token }` };
}

export class DesktopVaultClient {
  async unlock(masterPassword: string): Promise<void> {
    const bootstrap = await request('/v1/desktop/bootstrap').catch((error: Error) => {
      if (error.message.includes('(404)')) return null;
      throw error;
    });
    if (!bootstrap) {
      const master = await deriveMasterKey(masterPassword);
      const { createUserKey, createUserKeyPair } = await import('../../../../packages/vault-crypto/src/index');
      const created = await createUserKey(master.key);
      const pair = await createUserKeyPair(created.userKey);
      await request('/v1/desktop/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        loginHash: await deriveLoginHash(master.key), publicKey: pair.publicKey, encryptedPrivateKey: pair.encryptedPrivateKey,
        encryptedUserKey: created.encryptedUserKey, kdf: { salt: master.salt, parameters: master.parameters },
      }) });
    }
    const master = await deriveMasterKey(masterPassword, bootstrap?.kdf?.salt, bootstrap?.kdf?.parameters);
    const loginHash = await deriveLoginHash(master.key);
    const result = await request('/v1/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginHash }) });
    const userKey = await unwrapUserKey(result.user.encryptedUserKey, master.key);
    session = { token: result.token, userId: result.user.id, userKey };
  }

  lock(): void { session?.userKey.fill(0); session = null; }
  isUnlocked(): boolean { return session !== null; }

  async list(): Promise<Array<RemoteItem & { plaintext: VaultItemPlaintext }>> {
    if (!session) throw new Error('Vault is locked');
    const result = await request('/v1/items', { headers: headers() });
    return Promise.all((result.items as RemoteItem[]).map(async item => ({
      ...item,
      plaintext: JSON.parse(await decryptItemText({ version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key }, session!.userKey, { itemId: item.id, ownerId: session!.userId })) as VaultItemPlaintext,
    })));
  }

  async get(id: string): Promise<RemoteItem & { plaintext: VaultItemPlaintext }> {
    if (!session) throw new Error('Vault is locked');
    const item = await request(`/v1/items/${ encodeURIComponent(id) }`, { headers: headers() }) as RemoteItem;
    return { ...item, plaintext: JSON.parse(await decryptItemText({ version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key }, session.userKey, { itemId: item.id, ownerId: session.userId })) };
  }

  async save(id: string | undefined, plaintext: VaultItemPlaintext, revision?: number): Promise<string> {
    if (!session) throw new Error('Vault is locked');
    const itemId = id || crypto.randomUUID();
    const encrypted = await encryptItem(JSON.stringify(plaintext), session.userKey, { itemId, ownerId: session.userId });
    const body = { id: itemId, itemType: plaintext.type, ciphertext: encrypted.ciphertext, encryptedItemKey: encrypted.encryptedItemKey,
      agentWrappedItemKey: encrypted.agentWrappedItemKey, agentPolicy: plaintext.agentPolicy };
    if (id) await request(`/v1/items/${ encodeURIComponent(id) }`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ ...body, revision }) });
    else await request('/v1/items', { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    return itemId;
  }

  async remove(id: string, revision: number): Promise<void> {
    await request(`/v1/items/${ encodeURIComponent(id) }?revision=${ revision }`, { method: 'DELETE', headers: headers() });
  }

  async audit(event: Record<string, unknown>): Promise<void> {
    await request('/v1/audit', { method: 'POST', headers: headers(), body: JSON.stringify(event) });
  }
}

let client: DesktopVaultClient | null = null;
export function getDesktopVaultClient(): DesktopVaultClient {
  return client || (client = new DesktopVaultClient());
}
