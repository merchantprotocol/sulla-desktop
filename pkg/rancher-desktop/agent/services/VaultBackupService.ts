/** Container-owned backup/recovery facade; Desktop never exports keys or decrypts snapshots. */
import { getDesktopVaultClient, type HumanVaultSession } from './DesktopVaultClient';

export const SNAPSHOT_FORMAT = 'sulla-vault-snapshot';
export type RestoreMode = 'merge' | 'overwrite';
export interface VaultSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: number;
  createdAt: string;
  reason: string;
  rowCount: number;
  rowsSha256: string;
  keyMaterial: unknown;
  rows: unknown[];
}
export interface RestoreResult { inserted: number; updated: number; skipped: number; unreadable?: number }

export class SnapshotNeedsSecretError extends Error {
  constructor() { super('VAULT_UI_REQUIRED: restore backups in the isolated vault window'); this.name = 'SnapshotNeedsSecretError' }
}
export function isVaultSnapshot(value: unknown): value is VaultSnapshot {
  return Boolean(value && typeof value === 'object' && (value as VaultSnapshot).format === SNAPSHOT_FORMAT);
}
export function selectSnapshotsToKeep(_names: string[]): Set<string> { return new Set() }

export class VaultBackupService {
  get backupDir(): string { return '' }
  start(_onValueChange?: (callback: () => void) => void): void { /* container-owned */ }
  stop(): void { /* container-owned */ }
  scheduleSnapshot(): void { /* container-owned */ }
  async snapshotSafely(_reason: string): Promise<null> { return null }
  async createSnapshot(_reason: string, _options?: { force?: boolean }): Promise<string | null> { throw this.uiRequired() }
  listSnapshots(): string[] { return [] }
  async buildExport(): Promise<string> { throw this.uiRequired() }
  async restoreSnapshot(_snapshot: VaultSnapshot, _options?: unknown): Promise<RestoreResult> { throw this.uiRequired() }
  async openBackupUi(): Promise<HumanVaultSession> { return await getDesktopVaultClient().createHumanSession() }
  private uiRequired(): Error { return new Error('VAULT_UI_REQUIRED: manage backups in the isolated vault window') }
}

let instance: VaultBackupService | null = null;
export function getVaultBackupService(): VaultBackupService { return instance ?? (instance = new VaultBackupService()) }
