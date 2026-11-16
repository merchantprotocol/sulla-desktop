// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Container-owned local vault control client. It never handles key material. */
import fs from 'node:fs/promises';
import path from 'node:path';

import { safeStorage, session } from 'electron';

import type {
  BrowserFillTarget,
  HumanSessionResponse,
  LegacyMigrationResponse,
  LocalVaultErrorResponse,
  LocalVaultStatusResponse,
} from '../../../../services/sulla-vault/src/contracts';

import paths from '@pkg/utils/paths';
import { vaultTlsPins, VAULT_HTTPS_ORIGIN, VaultTlsPinService } from '@pkg/main/vaultTls';

const DEFAULT_API = VAULT_HTTPS_ORIGIN;
const REQUEST_TIMEOUT_MS = 15_000;
const CONTROL_TOKEN_FILE = 'vault-control-token.enc';
const CONTROL_PARTITION = 'sulla-vault-control';
const CONTROL_SERVICE_ID = 'sulla-desktop-control';
const MIN_CONTROL_TOKEN_LENGTH = 32;

export class LocalVaultError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly operationId?: string) {
    super(message);
    this.name = 'LocalVaultError';
  }
}

export interface VaultControlIdentity { serviceId: string; token: string }
export interface HumanVaultSession { url: string; expiresAt: number; phase: HumanSessionResponse['phase'] }
type DesktopVaultStatus = LocalVaultStatusResponse & { setup?: { required: boolean } };

/** Reads the OS-protected control capability the runtime provisions. Decrypts per call; never caches plaintext. */
export class VaultControlIdentityRepository {
  constructor(
    private readonly safeStorageApi: () => Electron.SafeStorage = () => safeStorage,
    private readonly appHome: () => string = () => paths.appHome,
    private readonly readFile: (filePath: string) => Promise<Buffer> = filePath => fs.readFile(filePath),
  ) {}

  async load(): Promise<VaultControlIdentity> {
    const storage = this.safeStorageApi();
    if (!storage.isEncryptionAvailable()) {
      throw new LocalVaultError('vault_unavailable', 'OS key storage is unavailable', 503);
    }
    const encrypted = await this.readFile(path.join(this.appHome(), CONTROL_TOKEN_FILE));
    const token = storage.decryptString(encrypted).trim();
    if (token.length < MIN_CONTROL_TOKEN_LENGTH) throw new LocalVaultError('vault_unavailable', 'Vault control capability is not provisioned', 503);

    return { serviceId: CONTROL_SERVICE_ID, token };
  }
}

/** Holds the one control session, pinned to the local vault certificate. A failed setup is retried on the next call. */
export class VaultControlSessionProvider {
  private controlSession: Promise<Electron.Session> | undefined;

  constructor(
    private readonly createSession: () => Electron.Session = () => session.fromPartition(CONTROL_PARTITION, { cache: false }),
    private readonly pins: VaultTlsPinService = vaultTlsPins,
  ) {}

  get(): Promise<Electron.Session> {
    this.controlSession ??= this.createPinnedSession().catch((error) => {
      this.controlSession = undefined;
      throw error;
    });

    return this.controlSession;
  }

  private async createPinnedSession(): Promise<Electron.Session> {
    const value = this.createSession();
    await this.pins.configureSession(value);

    return value;
  }
}

export class DesktopVaultClient {
  private lastStatus: DesktopVaultStatus = { state: 'locked', unlocked: false, cacheUpdateRequired: false, migration: { required: false } };

  constructor(
    private readonly api = DEFAULT_API,
    private readonly identity: () => Promise<VaultControlIdentity> = () => new VaultControlIdentityRepository().load(),
    private readonly sessions: VaultControlSessionProvider = vaultControlSessions,
  ) {}

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
      response = await (await this.sessions.get()).fetch(`${ this.api }${ requestPath }`, {
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

  async createHumanSession(browserTarget?: BrowserFillTarget): Promise<HumanVaultSession> {
    const result = await this.request<HumanSessionResponse>('/v1/human/session', {
      method: 'POST', body: browserTarget ? JSON.stringify({ browserTarget }) : undefined,
    });
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

/** Owns the process-wide Desktop vault client. Created on first use, replaced only by `configure`. */
export class DesktopVaultClientProvider {
  private client: DesktopVaultClient | null = null;

  constructor(private readonly sessions: VaultControlSessionProvider = vaultControlSessions) {}

  configure(identity: () => Promise<VaultControlIdentity>): DesktopVaultClient {
    return this.client = new DesktopVaultClient(DEFAULT_API, identity, this.sessions);
  }

  get(): DesktopVaultClient {
    return this.client ??= new DesktopVaultClient(DEFAULT_API, undefined, this.sessions);
  }
}

const vaultControlSessions = new VaultControlSessionProvider();
const desktopVaultClients = new DesktopVaultClientProvider(vaultControlSessions);

/** Compatibility seam for `sulla.ts`, `sullaCloudAuth.ts` and other callers; prefer injecting a `DesktopVaultClient`. */
export function configureDesktopVaultClient(identity: () => Promise<VaultControlIdentity>): DesktopVaultClient {
  return desktopVaultClients.configure(identity);
}

/** Compatibility seam for existing callers; prefer injecting a `DesktopVaultClient`. */
export function getDesktopVaultClient(): DesktopVaultClient {
  return desktopVaultClients.get();
}
