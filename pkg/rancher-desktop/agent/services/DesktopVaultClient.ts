/** Container-owned local vault control client. It never handles key material. */
import fs from 'node:fs/promises';
import path from 'node:path';

import { safeStorage, session } from 'electron';

import type {
  HumanSessionResponse,
  LegacyMigrationResponse,
  LocalVaultErrorResponse,
  LocalVaultStatusResponse,
} from '../../../../services/sulla-vault/src/contracts';

import paths from '@pkg/utils/paths';
import { configureVaultPinnedSession, VAULT_HTTPS_ORIGIN } from '@pkg/main/vaultTls';

const DEFAULT_API = VAULT_HTTPS_ORIGIN;
const REQUEST_TIMEOUT_MS = 15_000;
let controlSession: Promise<Electron.Session> | undefined;

async function getControlSession(): Promise<Electron.Session> {
  controlSession ??= (async() => {
    const value = session.fromPartition('sulla-vault-control', { cache: false });
    await configureVaultPinnedSession(value);
    return value;
  })();
  try {
    return await controlSession;
  } catch (error) {
    controlSession = undefined;
    throw error;
  }
}

export class LocalVaultError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly operationId?: string) {
    super(message);
    this.name = 'LocalVaultError';
  }
}

export interface VaultControlIdentity { serviceId: string; token: string }
export interface HumanVaultSession { url: string; expiresAt: number; phase: HumanSessionResponse['phase'] }
type DesktopVaultStatus = LocalVaultStatusResponse & { setup?: { required: boolean } };

async function defaultControlIdentity(): Promise<VaultControlIdentity> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new LocalVaultError('vault_unavailable', 'OS key storage is unavailable', 503);
  }
  const encrypted = await fs.readFile(path.join(paths.appHome, 'vault-control-token.enc'));
  const token = safeStorage.decryptString(encrypted).trim();
  if (token.length < 32) throw new LocalVaultError('vault_unavailable', 'Vault control capability is not provisioned', 503);
  return { serviceId: 'sulla-desktop-control', token };
}

export class DesktopVaultClient {
  private lastStatus: DesktopVaultStatus = { state: 'locked', unlocked: false, cacheUpdateRequired: false, migration: { required: false } };

  constructor(private readonly api = DEFAULT_API, private readonly identity: () => Promise<VaultControlIdentity> = defaultControlIdentity) {}

  private async request<T>(requestPath: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body) headers.set('content-type', 'application/json');
    if (authenticated) {
      const identity = await this.identity();
      headers.set('x-sulla-service-id', identity.serviceId);
      headers.set('authorization', `Bearer ${ identity.token }`);
    }
    let response: Response;
    try {
      response = await (await getControlSession()).fetch(`${ this.api }${ requestPath }`, {
        ...init,
        headers,
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new LocalVaultError('vault_unavailable', `Vault service is unavailable: ${ (error as Error).message }`, 503);
    }
    const body = await response.json().catch(() => ({})) as T & Partial<LocalVaultErrorResponse>;
    if (!response.ok) {
      throw new LocalVaultError(
        typeof body.error === 'string' ? body.error : 'vault_unavailable',
        typeof body.message === 'string' ? body.message : `Vault request failed (${ response.status })`,
        response.status,
        body.operationId,
      );
    }
    return body;
  }

  async status(): Promise<DesktopVaultStatus> {
    return this.lastStatus = await this.request<DesktopVaultStatus>('/v1/desktop/status');
  }

  cachedStatus(): DesktopVaultStatus { return this.lastStatus }

  acceptBootstrapResult(state: LocalVaultStatusResponse['state']): void {
    this.lastStatus = { state, unlocked: state === 'unlocked', cacheUpdateRequired: false, migration: { required: state === 'migration_required' } };
  }

  async lock(): Promise<LocalVaultStatusResponse> {
    this.markLocked();
    try {
      return this.lastStatus = await this.request<LocalVaultStatusResponse>('/v1/desktop/lock', { method: 'POST' });
    } catch (error) { this.markLocked(); throw error }
  }

  markLocked(): void { this.lastStatus = { state: 'locked', unlocked: false, cacheUpdateRequired: false, migration: { required: false } } }
  isSetUp(): boolean | undefined { return this.lastStatus.setup ? !this.lastStatus.setup.required : undefined }

  async migrate(): Promise<LegacyMigrationResponse> {
    const result = await this.request<LegacyMigrationResponse>('/v1/desktop/migrate', { method: 'POST' });
    await this.status();
    return result;
  }

  async createHumanSession(): Promise<HumanVaultSession> {
    const result = await this.request<HumanSessionResponse>('/v1/human/session', { method: 'POST' });
    const url = new URL(result.url, this.api);
    if (url.origin !== new URL(this.api).origin || !url.pathname.startsWith('/vault/')) {
      throw new LocalVaultError('invalid_human_session', 'Vault returned an invalid human-session URL', 502);
    }
    // CSRF is intentionally discarded: only the same-origin container page uses it.
    return { url: url.toString(), expiresAt: result.expiresAt, phase: result.phase };
  }

  isUnlocked(): boolean { return this.lastStatus.unlocked }
  async ensureUnlocked(): Promise<boolean> { return (await this.status()).unlocked }

  // Fail-closed compatibility while remaining callers move to broker operations.
  async list(): Promise<any[]> { throw this.secretEgressError() }
  async get(_id: string): Promise<any> { throw this.secretEgressError() }
  async save(..._args: any[]): Promise<string> { throw this.secretEgressError() }
  async remove(..._args: any[]): Promise<void> { throw this.secretEgressError() }
  async resolveCredential(..._args: any[]): Promise<string | null> { throw this.secretEgressError() }
  async withAgentKeyPair<T>(_fn: (key: { publicKey: string; privateKey: Buffer }) => Promise<T>): Promise<T> { throw this.secretEgressError() }
  auditFor(_itemId?: string): any[] { return [] }

  private secretEgressError(): LocalVaultError {
    return new LocalVaultError('unsupported_secret_egress', 'Use the opaque vault broker or isolated human UI', 403);
  }
}

let client: DesktopVaultClient | null = null;
export function configureDesktopVaultClient(identity: () => Promise<VaultControlIdentity>): DesktopVaultClient {
  return client = new DesktopVaultClient(DEFAULT_API, identity);
}
export function getDesktopVaultClient(): DesktopVaultClient { return client ?? (client = new DesktopVaultClient()) }
