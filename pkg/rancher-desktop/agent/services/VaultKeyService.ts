/**
 * Desktop vault lifecycle facade.
 *
 * Key bytes are never unwrapped in this process. initialize() launches the
 * same signed Electron executable in its bootstrap-only entry path; that
 * process performs safeStorage unwrap and the direct sealed handoff, then exits.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { getDesktopVaultClient } from './DesktopVaultClient';

import paths from '@pkg/utils/paths';

export const VAULT_PREFIX = '$VAULT$';
export type VaultDecryptor = (encrypted: string) => string;
export interface VaultKeyMaterial { salt?: string; wrapped?: string; recoveryBackup?: string; canary?: string }
export interface SafeStorageLike { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }

export function normalizeRecoveryKey(value: string): string {
  return value.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

export function writeFileAtomic(filePath: string, data: string | Buffer, mode = 0o600): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${ filePath }.tmp-${ process.pid }`;
  fs.writeFileSync(temporary, data, { mode });
  fs.renameSync(temporary, filePath);
}

interface BootstrapProcessResult { ok: boolean; state?: 'locked' | 'unlocked' | 'migration_required' | 'migration_failed'; updated?: boolean; error?: string }

export class VaultKeyService {
  private readonly identityPath = path.join(paths.appHome, 'vault-bootstrap-identity.enc');
  private readonly masterKeyPath = path.join(paths.appHome, 'vault-v2-key.enc');
  private readonly legacyVmkPath = path.join(paths.sullaConfig, 'vault-key.enc');
  private readonly tlsFingerprintPath = path.join(paths.appHome, 'vault-tls-fingerprint');
  private bootstrapRun: Promise<boolean> | null = null;
  private cacheUpdateRun: Promise<boolean> | null = null;
  private lastCacheUpdateAttempt = 0;

  // Kept for source compatibility with old synthetic fixtures. Arguments are
  // deliberately ignored; this facade never accepts an in-process decryptor.
  constructor(_sullaDir?: string, _safeStorageOverride?: SafeStorageLike) {}

  initialize(): Promise<boolean> {
    this.bootstrapRun ??= this.runBootstrapProcess().finally(() => { this.bootstrapRun = null });
    return this.bootstrapRun;
  }

  private async runBootstrapProcess(): Promise<boolean> {
    if (![this.identityPath, this.masterKeyPath].every(file => fs.existsSync(file))) {
      return getDesktopVaultClient().status().then(status => status.unlocked, () => false);
    }
    const result = await this.runIsolatedHelper('--sulla-vault-bootstrap-helper');
    if (!result.ok || !result.state) {
      console.warn('[VaultKeyService] Isolated bootstrap did not unlock the vault:', result.error ?? 'unknown error');
      return false;
    }
    getDesktopVaultClient().acceptBootstrapResult(result.state);
    return result.state === 'unlocked';
  }

  refreshMasterCache(): Promise<boolean> {
    if (!this.cacheUpdateRun && Date.now() - this.lastCacheUpdateAttempt < 5_000) return Promise.resolve(false);
    this.lastCacheUpdateAttempt = Date.now();
    this.cacheUpdateRun ??= this.runMasterCacheUpdate().finally(() => { this.cacheUpdateRun = null });
    return this.cacheUpdateRun;
  }

  private async runMasterCacheUpdate(): Promise<boolean> {
    if (![this.identityPath, this.tlsFingerprintPath].every(file => fs.existsSync(file))) return false;
    const result = await this.runIsolatedHelper('--sulla-vault-cache-update-helper');
    if (!result.ok || !result.updated) {
      console.warn('[VaultKeyService] Isolated master-cache update failed:', result.error ?? 'unknown error');
      return false;
    }
    return true;
  }

  private async runIsolatedHelper(flag: '--sulla-vault-bootstrap-helper' | '--sulla-vault-cache-update-helper'): Promise<BootstrapProcessResult> {
    return await new Promise<BootstrapProcessResult>((resolve) => {
      const args = process.defaultApp
        ? [app.getAppPath(), flag]
        : [flag];
      const child = spawn(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          SULLA_VAULT_BOOTSTRAP_IDENTITY_PATH: this.identityPath,
          SULLA_VAULT_MASTER_KEY_PATH:         this.masterKeyPath,
          SULLA_VAULT_LEGACY_VMK_PATH:         this.legacyVmkPath,
          SULLA_VAULT_TLS_FINGERPRINT_PATH:    this.tlsFingerprintPath,
        },
      });
      let output = '';
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: BootstrapProcessResult) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve(value);
      };
      timeout = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ ok: false, error: 'Bootstrap helper timed out' });
      }, 45_000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (output.length < 4_096) output += chunk.toString('utf8');
      });
      child.once('error', error => finish({ ok: false, error: error.message }));
      child.once('close', () => {
        try { finish(JSON.parse(output.trim()) as BootstrapProcessResult) } catch { finish({ ok: false, error: 'Bootstrap helper returned an invalid result' }) }
      });
    });
  }

  isUnlocked(): boolean { return getDesktopVaultClient().isUnlocked() }
  isSetUp(): boolean { return getDesktopVaultClient().isSetUp() !== false }
  canVerifyPassword(): boolean { return false }
  setCiphertextSampleProvider(_provider: unknown): void { /* retired: container verifies its own keys */ }

  lock(): void {
    getDesktopVaultClient().markLocked();
    void getDesktopVaultClient().lock().catch(error => console.error('[VaultKeyService] Container lock acknowledgement failed:', error));
  }

  async setupFromMasterPassword(_password: string): Promise<{ recoveryKey: string }> { throw this.humanUiRequired() }
  async changePassword(_current: string, _next: string): Promise<never> { throw this.humanUiRequired() }
  async recoverFromRecoveryKey(_key: string): Promise<boolean> { throw this.humanUiRequired() }
  async recoverFromMasterPassword(_password: string): Promise<boolean> { throw this.humanUiRequired() }
  generateRecoveryKey(): never { throw this.humanUiRequired() }

  isEncrypted(value: unknown): value is string { return typeof value === 'string' && value.startsWith(VAULT_PREFIX) }
  encrypt(_plaintext: unknown): never { throw this.secretEgressDenied() }
  decrypt(_ciphertext: unknown): never { throw this.secretEgressDenied() }
  exportKeyMaterial(): never { throw this.secretEgressDenied() }
  matchesKeyMaterial(_material: VaultKeyMaterial): false { return false }
  openKeyMaterial(_material: VaultKeyMaterial, _secret: unknown): null { return null }

  private humanUiRequired(): Error { return new Error('VAULT_UI_REQUIRED: use the isolated vault window') }
  private secretEgressDenied(): Error { return new Error('unsupported_secret_egress') }
}

let instance: VaultKeyService | null = null;
export function getVaultKeyService(): VaultKeyService { return instance ?? (instance = new VaultKeyService()) }
