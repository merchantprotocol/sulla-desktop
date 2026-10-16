import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  agentPolicyAllows,
  createUserKey,
  createUserKeyPair,
  decryptItemText,
  deriveLoginHash,
  deriveMasterKey,
  encryptItem,
  unwrapUserPrivateKey,
  unwrapUserKey,
  type AgentAccessLevel,
  type AgentPolicy,
  type EncryptedItem,
  type VaultItemPlaintext,
} from '../../../../packages/vault-crypto/src/index';
import paths from '../../utils/paths';

const DEFAULT_API = 'http://127.0.0.1:30121';
// Server tokens last 12h; reopen a little before that so requests never 401.
const SESSION_LIFETIME_MS = 11 * 60 * 60 * 1000;

export interface RemoteVaultItem {
  id:                      string;
  item_type:               string;
  ciphertext:              EncryptedItem['ciphertext'];
  encrypted_item_key:      EncryptedItem['encryptedItemKey'];
  agent_wrapped_item_key?: EncryptedItem['agentWrappedItemKey'];
  revision:                number;
  created_at:              string;
  updated_at:              string;
  agent_policy?:           AgentPolicy;
  plaintext:               VaultItemPlaintext;
}

export interface VaultAuditEvent {
  id:        string;
  itemId:    string;
  agentId:   string;
  action:    string;
  level:     AgentAccessLevel;
  host?:     string;
  blocked:   boolean;
  reason?:   string;
  createdAt: string;
}

export interface CredentialUseRequest {
  itemId?:        string;
  integrationId?: string;
  accountId?:     string;
  property:       string;
  agentId:        string;
  level:          AgentAccessLevel;
  host?:          string;
  onServer?:      boolean;
}

interface Session {
  token:      string;
  userId:     string;
  userKey:    Uint8Array;
  publicKey:  string;
  privateKey: Uint8Array;
  expiresAt:  number;
}
type ApprovalPrompt = (item: VaultItemPlaintext, request: CredentialUseRequest) => Promise<boolean>;

export class DesktopVaultClient {
  private session:              Session | null = null;
  private reopening:            Promise<boolean> | null = null;
  private readonly recentAudit: VaultAuditEvent[] = [];
  private readonly keyCachePath = path.join(paths.appHome, 'vault-v2-key.enc');

  constructor(private readonly api = DEFAULT_API, private readonly approvalPrompt?: ApprovalPrompt) {}

  private async request(requestPath: string, init: RequestInit = {}, allowFailure = false): Promise<any> {
    const response = await fetch(`${ this.api }${ requestPath }`, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok && !allowFailure) {
      // A rejected token means the session is gone; drop it so the next call reopens.
      if (response.status === 401 && this.session) this.lock();
      const reason = typeof body.reason === 'string' ? `: ${ body.reason }` : '';
      throw new Error(`Vault request failed (${ response.status })${ reason }`);
    }
    return { ...body, __status: response.status, __ok: response.ok };
  }

  private requireSession(): Session {
    if (!this.session) throw new Error('Vault is locked');
    if (Date.now() >= this.session.expiresAt) {
      this.lock();
      throw new Error('Vault session expired');
    }
    return this.session;
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${ this.requireSession().token }` };
  }

  async unlock(masterPassword: string): Promise<void> {
    let bootstrap = await this.request('/v1/desktop/bootstrap', {}, true);
    if (bootstrap.__status === 404) {
      const master = await deriveMasterKey(masterPassword);
      const created = await createUserKey(master.key);
      const pair = await createUserKeyPair(created.userKey);
      await this.request('/v1/desktop/bootstrap', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({
          loginHash:           await deriveLoginHash(master.key),
          publicKey:           pair.publicKey,
          encryptedPrivateKey: pair.encryptedPrivateKey,
          encryptedUserKey:    created.encryptedUserKey,
          kdf:                 { salt: master.salt, parameters: master.parameters },
        }),
      });
      bootstrap = { kdf: { salt: master.salt, parameters: master.parameters } };
      master.key.fill(0);
      created.userKey.fill(0);
    } else if (!bootstrap.__ok) {
      throw new Error(`Vault bootstrap failed (${ bootstrap.__status })`);
    }

    const master = await deriveMasterKey(masterPassword, bootstrap.kdf?.salt, bootstrap.kdf?.parameters);
    try {
      await this.openSession(master.key);
      await this.cacheMasterKey(master.key);
    } finally {
      master.key.fill(0);
    }
  }

  async unlockFromKeychain(): Promise<boolean> {
    try {
      if (!fs.existsSync(this.keyCachePath)) return false;
      const { safeStorage } = await import('electron');
      if (!safeStorage.isEncryptionAvailable()) return false;
      const masterKey = Buffer.from(safeStorage.decryptString(fs.readFileSync(this.keyCachePath)), 'base64');
      try {
        await this.openSession(masterKey);
        return true;
      } finally {
        masterKey.fill(0);
      }
    } catch {
      return false;
    }
  }

  private async openSession(masterKey: Uint8Array): Promise<void> {
    const result = await this.request('/v1/session', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ loginHash: await deriveLoginHash(masterKey) }),
    });
    const userKey = await unwrapUserKey(result.user.encryptedUserKey, masterKey);
    try {
      const privateKey = await unwrapUserPrivateKey(result.user.encryptedPrivateKey, userKey);
      this.lock();
      this.session = {
        token:     result.token,
        userId:    result.user.id,
        userKey,
        publicKey: result.user.publicKey,
        privateKey,
        expiresAt: Date.now() + SESSION_LIFETIME_MS,
      };
    } catch (error) {
      userKey.fill(0);
      throw error;
    }
  }

  private async cacheMasterKey(masterKey: Uint8Array): Promise<void> {
    try {
      const { safeStorage } = await import('electron');
      if (!safeStorage.isEncryptionAvailable()) return;
      fs.mkdirSync(path.dirname(this.keyCachePath), { recursive: true, mode: 0o700 });
      const encrypted = safeStorage.encryptString(Buffer.from(masterKey).toString('base64'));
      fs.writeFileSync(this.keyCachePath, encrypted, { mode: 0o600 });
    } catch { /* Password unlock remains available when keychain caching is unavailable. */ }
  }

  lock(): void {
    this.session?.userKey.fill(0);
    this.session?.privateKey.fill(0);
    this.session = null;
  }

  /**
   * Sulla Vault follows the main Sulla unlock: while Sulla is unlocked, reopen
   * the session from the keychain-cached key instead of asking for a password.
   * A manual lock locks Sulla too, so this never undoes it.
   */
  async ensureUnlocked(): Promise<boolean> {
    if (this.isUnlocked()) return true;
    const { getVaultKeyService } = await import('./VaultKeyService');
    if (!getVaultKeyService().isUnlocked()) return false;
    this.reopening ??= this.unlockFromKeychain().finally(() => { this.reopening = null });
    return this.reopening;
  }

  private async withSession(): Promise<Session> {
    if (!await this.ensureUnlocked()) throw new Error('Vault is locked');
    return this.requireSession();
  }

  isUnlocked(): boolean {
    if (this.session && Date.now() >= this.session.expiresAt) this.lock();
    return this.session !== null;
  }

  async list(): Promise<RemoteVaultItem[]> {
    const active = await this.withSession();
    const result = await this.request('/v1/items', { headers: this.headers() });
    return Promise.all((result.items as Omit<RemoteVaultItem, 'plaintext'>[]).map(async item => ({
      ...item,
      plaintext: JSON.parse(await decryptItemText(
        { version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key },
        active.userKey, { itemId: item.id, ownerId: active.userId },
      )) as VaultItemPlaintext,
    })));
  }

  async get(id: string): Promise<RemoteVaultItem> {
    const active = await this.withSession();
    const item = await this.request(`/v1/items/${ encodeURIComponent(id) }`, { headers: this.headers() });
    return {
      ...item,
      plaintext: JSON.parse(await decryptItemText(
        { version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key },
        active.userKey, { itemId: item.id, ownerId: active.userId },
      )),
    };
  }

  async save(id: string | undefined, plaintext: VaultItemPlaintext, revision?: number): Promise<string> {
    const active = await this.withSession();
    const itemId = id || crypto.randomUUID();
    const encrypted = await encryptItem(
      JSON.stringify(plaintext), active.userKey, { itemId, ownerId: active.userId },
      plaintext.agentPolicy.mode === 'agents' ? active.publicKey : undefined,
    );
    const body = {
      id:                  itemId,
      itemType:            plaintext.type,
      ciphertext:          encrypted.ciphertext,
      encryptedItemKey:    encrypted.encryptedItemKey,
      agentWrappedItemKey: encrypted.agentWrappedItemKey ?? null,
      agentPolicy:         plaintext.agentPolicy,
      integrationRef:      plaintext.integration
        ? `${ plaintext.integration.integrationId }/${ plaintext.integration.accountId }`
        : null,
    };
    if (id) {
      await this.request(`/v1/items/${ encodeURIComponent(id) }`, {
        method: 'PATCH', headers: this.headers(), body: JSON.stringify({ ...body, revision }),
      });
    } else {
      await this.request('/v1/items', { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    }
    return itemId;
  }

  /** Give a trusted provisioning callback a short-lived copy of the agent key. */
  async withAgentKeyPair<T>(fn: (key: { publicKey: string; privateKey: Buffer }) => Promise<T>): Promise<T> {
    const active = await this.withSession();
    const privateKey = Buffer.from(active.privateKey);
    try {
      return await fn({ publicKey: active.publicKey, privateKey });
    } finally {
      privateKey.fill(0);
    }
  }

  async remove(id: string, revision: number): Promise<void> {
    await this.withSession();
    await this.request(`/v1/items/${ encodeURIComponent(id) }?revision=${ revision }`, { method: 'DELETE', headers: this.headers() });
  }

  auditFor(itemId?: string): VaultAuditEvent[] {
    return this.recentAudit.filter(event => !itemId || event.itemId === itemId).slice(0, 50);
  }

  async resolveCredential(request: CredentialUseRequest): Promise<string | null> {
    const items = await this.list();
    const item = items.find(candidate => request.itemId
      ? candidate.id === request.itemId
      : candidate.plaintext.integration?.integrationId === request.integrationId &&
      candidate.plaintext.integration?.accountId === request.accountId);
    if (!item) return null;

    const policy = agentPolicyAllows(item.plaintext.agentPolicy, request);
    if (!policy.allowed) {
      await this.recordAgentUse(item.id, request, true, policy.reason || 'Agent policy denied this request');
      throw new Error(policy.reason || 'Vault access denied');
    }
    if (item.plaintext.agentPolicy.askFirst) {
      const approved = await (this.approvalPrompt ?? defaultApprovalPrompt)(item.plaintext, request);
      if (!approved) {
        await this.recordAgentUse(item.id, request, true, 'The owner denied this use');
        throw new Error('The owner denied this vault request');
      }
    }

    const value = item.plaintext.integration?.properties?.[request.property] ??
      (request.property === 'username' ? item.plaintext.username : undefined) ??
      (['password', 'api_key', 'bearer_token'].includes(request.property) ? item.plaintext.password : undefined) ??
      item.plaintext.fields?.find(field => field.name === request.property)?.value;
    if (value == null) return null;
    await this.recordAgentUse(item.id, request, false);
    return value;
  }

  private async recordAgentUse(itemId: string, request: CredentialUseRequest, blocked: boolean, reason?: string): Promise<void> {
    const event: VaultAuditEvent = {
      id:        crypto.randomUUID(),
      itemId,
      agentId:   request.agentId,
      action:    'agent_credential_use',
      level:     request.level,
      host:      request.host,
      blocked,
      reason,
      createdAt: new Date().toISOString(),
    };
    this.recentAudit.unshift(event);
    this.recentAudit.splice(100);
    await this.request('/v1/audit', {
      method:  'POST',
      headers: this.headers(),
      body:    JSON.stringify({
        itemId,
        action:   blocked ? 'desktop_agent_credential_use_blocked' : 'desktop_agent_credential_use',
        metadata: { agentId: request.agentId, level: request.level, host: request.host, blocked, reason },
      }),
    }, true);
  }
}

async function defaultApprovalPrompt(item: VaultItemPlaintext, request: CredentialUseRequest): Promise<boolean> {
  try {
    const { dialog } = await import('electron');
    const result = await dialog.showMessageBox({
      type:      'question',
      title:     'Allow vault access?',
      message:   `${ request.agentId } wants to use ${ item.name }`,
      detail:    `Access: ${ request.level }${ request.host ? ` on ${ request.host }` : '' }. The secret will not be shown in this prompt.`,
      buttons:   ['Deny', 'Allow once'],
      defaultId: 1,
      cancelId:  0,
      noLink:    true,
    });
    return result.response === 1;
  } catch {
    return false;
  }
}

let client: DesktopVaultClient | null = null;
export function getDesktopVaultClient(): DesktopVaultClient {
  return client || (client = new DesktopVaultClient());
}
