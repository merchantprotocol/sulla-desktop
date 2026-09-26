// VaultBackupService - automatic, self-contained, ciphertext-only snapshots of
// the credential vault.
//
// Why: vault rows live in Postgres inside the VM's Docker volume. A VM reset,
// a corrupted disk, a mistaken delete, or a bad import would otherwise lose
// every stored password. Snapshots are written to the host under
// ~/.sulla/vault-backups and contain:
//   * every integration_values row, with values as $VAULT$ ciphertext only
//     (plaintext rows are encrypted before they are written), and
//   * the vault key material (wrapped VMK / legacy salt, recovery backup,
//     canary) — never an unwrapped key.
// So a snapshot can be restored on any machine with either the master
// password or the recovery key, and is useless to anyone holding neither.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { getVaultKeyService, writeFileAtomic, type VaultDecryptor, type VaultKeyMaterial, type VaultKeyService } from './VaultKeyService';

import paths from '@pkg/utils/paths';

export const SNAPSHOT_FORMAT = 'sulla-vault-snapshot';
const SNAPSHOT_PREFIX = 'vault-snapshot-';
const SNAPSHOT_SUFFIX = '.json';
const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHANGE_DEBOUNCE_MS = 30_000;

// Retention: newest N always, plus newest-per-day and newest-per-month windows.
// Tiering means a burst of bad writes can't rotate every good snapshot out.
const KEEP_RECENT = 20;
const KEEP_DAILY = 30;
const KEEP_MONTHLY = 12;

export interface VaultRow {
  integration_id: string;
  account_id:     string;
  property:       string;
  value:          string;
  is_default:     boolean;
  created_at?:    string | null;
  updated_at?:    string | null;
}

export interface VaultSnapshot {
  format:      typeof SNAPSHOT_FORMAT;
  version:     1;
  createdAt:   string;
  reason:      string;
  rowCount:    number;
  rowsSha256:  string;
  keyMaterial: VaultKeyMaterial;
  rows:        VaultRow[];
}

export type RestoreMode = 'merge' | 'overwrite';

export interface RestoreResult {
  inserted:   number;
  updated:    number;
  skipped:    number;
  /** Rows in the snapshot that could not be decrypted and were not written. */
  unreadable?: number;
}

/** Persistence seam so snapshot/restore logic is testable without Postgres. */
export interface VaultRowStore {
  listRows(): Promise<VaultRow[]>;
  /** Must be atomic: either every row applies or none do. */
  applyRows(rows: VaultRow[], mode: RestoreMode): Promise<RestoreResult>;
}

export class SnapshotNeedsSecretError extends Error {
  constructor() {
    super('VAULT_SNAPSHOT_NEEDS_SECRET: this backup was made with a different vault key — enter that vault\'s master password or recovery key');
    this.name = 'SnapshotNeedsSecretError';
  }
}

export function isVaultSnapshot(value: unknown): value is VaultSnapshot {
  const v = value as VaultSnapshot;

  return !!v && typeof v === 'object' && v.format === SNAPSHOT_FORMAT && Array.isArray(v.rows) && !!v.keyMaterial;
}

function hashRows(rows: VaultRow[], material: VaultKeyMaterial): string {
  const h = crypto.createHash('sha256');

  h.update(JSON.stringify(material));
  for (const r of rows) {
    h.update(JSON.stringify([r.integration_id, r.account_id, r.property, r.value, !!r.is_default]));
  }

  return h.digest('hex');
}

function sortRows(rows: VaultRow[]): VaultRow[] {
  return [...rows].sort((a, b) => a.integration_id.localeCompare(b.integration_id) ||
    a.account_id.localeCompare(b.account_id) ||
    a.property.localeCompare(b.property));
}

/**
 * Pick which snapshot files to keep. Input names must embed an ISO-like UTC
 * timestamp (vault-snapshot-YYYYMMDDTHHMMSSmmmZ.json) so lexical = chronological.
 */
export function selectSnapshotsToKeep(names: string[]): Set<string> {
  const sorted = [...names].sort().reverse();
  const keep = new Set(sorted.slice(0, KEEP_RECENT));
  const days = new Set<string>();
  const months = new Set<string>();

  for (const name of sorted) {
    const stamp = name.slice(SNAPSHOT_PREFIX.length);
    const day = stamp.slice(0, 8);
    const month = stamp.slice(0, 6);

    if (!days.has(day) && days.size < KEEP_DAILY) {
      days.add(day);
      keep.add(name);
    }
    if (!months.has(month) && months.size < KEEP_MONTHLY) {
      months.add(month);
      keep.add(name);
    }
  }

  return keep;
}

class PostgresVaultRowStore implements VaultRowStore {
  async listRows(): Promise<VaultRow[]> {
    const { postgresClient } = await import('../database/PostgresClient');
    const rows = await postgresClient.queryAll(
      `SELECT "integration_id", "account_id", "property", "value", "is_default", "created_at", "updated_at"
         FROM "integration_values"`,
      [],
    );

    return rows.map((r: any) => ({
      integration_id: String(r.integration_id),
      account_id:     String(r.account_id),
      property:       String(r.property),
      value:          String(r.value ?? ''),
      is_default:     !!r.is_default,
      created_at:     r.created_at ? new Date(r.created_at).toISOString() : null,
      updated_at:     r.updated_at ? new Date(r.updated_at).toISOString() : null,
    }));
  }

  async applyRows(rows: VaultRow[], mode: RestoreMode): Promise<RestoreResult> {
    const { postgresClient } = await import('../database/PostgresClient');

    return postgresClient.transaction(async(client) => {
      const result: RestoreResult = { inserted: 0, updated: 0, skipped: 0 };

      for (const r of rows) {
        const existing = await client.query(
          `SELECT 1 FROM "integration_values" WHERE "integration_id" = $1 AND "account_id" = $2 AND "property" = $3`,
          [r.integration_id, r.account_id, r.property],
        );

        if (existing.rowCount === 0) {
          await client.query(
            `INSERT INTO "integration_values" ("integration_id", "account_id", "property", "value", "is_default", "created_at", "updated_at")
             VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamp, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)`,
            [r.integration_id, r.account_id, r.property, r.value, r.is_default, r.created_at ?? null],
          );
          result.inserted++;
        } else if (mode === 'overwrite') {
          await client.query(
            `UPDATE "integration_values" SET "value" = $4, "updated_at" = CURRENT_TIMESTAMP
              WHERE "integration_id" = $1 AND "account_id" = $2 AND "property" = $3`,
            [r.integration_id, r.account_id, r.property, r.value],
          );
          result.updated++;
        } else {
          result.skipped++;
        }
      }

      return result;
    });
  }
}

let instance: VaultBackupService | null = null;

export function getVaultBackupService(): VaultBackupService {
  if (!instance) {
    instance = new VaultBackupService();
  }
  return instance;
}

export class VaultBackupService {
  private timer:         ReturnType<typeof setInterval> | null = null;
  private debounce:      ReturnType<typeof setTimeout> | null = null;
  private running:       Promise<string | null> | null = null;

  constructor(
    private readonly store: VaultRowStore = new PostgresVaultRowStore(),
    private readonly vault: VaultKeyService = getVaultKeyService(),
    private readonly dir: string = path.join(paths.sullaConfig, 'vault-backups'),
  ) {}

  get backupDir(): string {
    return this.dir;
  }

  /** Snapshot now, every 6h, and shortly after any credential change. */
  start(onValueChange?: (cb: () => void) => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.snapshotSafely('interval').catch(() => undefined) }, AUTO_INTERVAL_MS);
    this.timer.unref?.();
    onValueChange?.(() => this.scheduleSnapshot());
    this.snapshotSafely('startup').catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
  }

  scheduleSnapshot(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.snapshotSafely('change').catch(() => undefined) }, CHANGE_DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  /** Background-safe wrapper: never throws. */
  async snapshotSafely(reason: string): Promise<string | null> {
    try {
      return await this.createSnapshot(reason);
    } catch (err) {
      console.error(`[VaultBackup] Snapshot (${ reason }) failed:`, (err as Error).message);
      return null;
    }
  }

  /**
   * Write a snapshot unless the vault content is identical to the newest one.
   * Returns the snapshot path, or null when skipped.
   */
  createSnapshot(reason: string, opts: { force?: boolean } = {}): Promise<string | null> {
    // Serialize: concurrent snapshots would race on dedupe and pruning.
    const run = (this.running ?? Promise.resolve(null)).catch(() => null).then(() => this.writeSnapshot(reason, !!opts.force));

    this.running = run;

    return run;
  }

  private async writeSnapshot(reason: string, force: boolean): Promise<string | null> {
    if (!this.vault.isSetUp()) return null;
    if (!this.vault.isUnlocked()) {
      console.log('[VaultBackup] Vault locked — snapshot skipped');
      return null;
    }

    const rows = sortRows(await this.store.listRows()).map(r => ({
      ...r,
      // Snapshots never contain plaintext.
      value: this.vault.isEncrypted(r.value) ? r.value : this.vault.encrypt(r.value),
    }));
    const keyMaterial = this.vault.exportKeyMaterial();

    // Dedupe on content. (Plaintext rows get fresh IVs each time, so they
    // defeat dedupe until migrateToEncrypted() has run — acceptable churn.)
    const rowsSha256 = hashRows(rows, keyMaterial);
    const latest = this.listSnapshots()[0];

    if (!force && latest) {
      try {
        const prev = JSON.parse(fs.readFileSync(path.join(this.dir, latest), 'utf-8')) as VaultSnapshot;

        if (prev.rowsSha256 === rowsSha256) return null;
      } catch { /* unreadable latest — write a fresh one */ }
    }

    const snapshot: VaultSnapshot = {
      format:    SNAPSHOT_FORMAT,
      version:   1,
      createdAt: new Date().toISOString(),
      reason,
      rowCount:  rows.length,
      rowsSha256,
      keyMaterial,
      rows,
    };

    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const stamp = snapshot.createdAt.replace(/[-:.]/g, '');
    const file = path.join(this.dir, `${ SNAPSHOT_PREFIX }${ stamp }${ SNAPSHOT_SUFFIX }`);
    const body = JSON.stringify(snapshot);

    writeFileAtomic(file, body);

    // Verify what landed on disk before trusting it for pruning.
    const readBack = JSON.parse(fs.readFileSync(file, 'utf-8')) as VaultSnapshot;

    if (readBack.rowsSha256 !== rowsSha256 || readBack.rows.length !== rows.length) {
      throw new Error('VAULT_BACKUP_VERIFY_FAILED: snapshot read-back mismatch');
    }

    this.prune();
    console.log(`[VaultBackup] Snapshot written (${ reason }): ${ rows.length } rows → ${ path.basename(file) }`);

    return file;
  }

  /** Newest first. */
  listSnapshots(): string[] {
    try {
      return fs.readdirSync(this.dir)
        .filter(n => n.startsWith(SNAPSHOT_PREFIX) && n.endsWith(SNAPSHOT_SUFFIX))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  private prune(): void {
    const names = this.listSnapshots();
    const keep = selectSnapshotsToKeep(names);

    for (const name of names) {
      if (!keep.has(name)) {
        try { fs.unlinkSync(path.join(this.dir, name)) } catch { /* ignore */ }
      }
    }
  }

  /** Serialize a snapshot for an encrypted export (same self-contained format). */
  async buildExport(): Promise<string> {
    if (!this.vault.isUnlocked()) throw new Error('Vault is locked');
    const rows = sortRows(await this.store.listRows()).map(r => ({
      ...r,
      value: this.vault.isEncrypted(r.value) ? r.value : this.vault.encrypt(r.value),
    }));
    const keyMaterial = this.vault.exportKeyMaterial();
    const snapshot: VaultSnapshot = {
      format:     SNAPSHOT_FORMAT,
      version:    1,
      createdAt:  new Date().toISOString(),
      reason:     'export',
      rowCount:   rows.length,
      rowsSha256: hashRows(rows, keyMaterial),
      keyMaterial,
      rows,
    };

    return JSON.stringify(snapshot, null, 2);
  }

  /**
   * Restore a snapshot into the live vault. All rows are decrypted and
   * re-encrypted under the current key before anything is written, and the
   * write is a single transaction — a bad secret or a corrupt row changes
   * nothing. A safety snapshot of the current state is taken first.
   *
   * mode 'merge' (default) only adds rows that are missing; 'overwrite' also
   * replaces values of rows that exist.
   */
  async restoreSnapshot(
    snapshot: VaultSnapshot,
    opts: { mode?: RestoreMode; password?: string; recoveryKey?: string } = {},
  ): Promise<RestoreResult> {
    if (!isVaultSnapshot(snapshot)) throw new Error('VAULT_SNAPSHOT_INVALID: not a Sulla vault snapshot');
    if (!this.vault.isUnlocked()) throw new Error('VAULT_LOCKED: unlock the vault before restoring');
    if (snapshot.rowsSha256 && hashRows(snapshot.rows, snapshot.keyMaterial) !== snapshot.rowsSha256) {
      throw new Error('VAULT_SNAPSHOT_CORRUPT: snapshot checksum does not match its contents');
    }

    let decrypt: VaultDecryptor;

    if (this.vault.matchesKeyMaterial(snapshot.keyMaterial)) {
      decrypt = v => this.vault.decrypt(v);
    } else if (opts.password || opts.recoveryKey) {
      const opened = this.vault.openKeyMaterial(snapshot.keyMaterial, opts);

      if (!opened) throw new Error('VAULT_WRONG_PASSWORD: that password or recovery key does not open this backup');
      decrypt = opened;
    } else {
      throw new SnapshotNeedsSecretError();
    }

    // Decrypt and re-encrypt everything up front. A row that was already
    // corrupt when snapshotted is reported, never written as garbage.
    const prepared: VaultRow[] = [];
    let unreadable = 0;

    for (const r of snapshot.rows) {
      try {
        const plaintext = this.vault.isEncrypted(r.value) ? decrypt(r.value) : r.value;

        prepared.push({ ...r, value: this.vault.encrypt(plaintext) });
      } catch {
        unreadable++;
      }
    }
    if (unreadable > 0 && prepared.length === 0) {
      throw new Error('VAULT_WRONG_PASSWORD: no rows in this backup could be decrypted');
    }

    await this.createSnapshot('pre-restore', { force: true });
    const result: RestoreResult = { ...(await this.store.applyRows(prepared, opts.mode ?? 'merge')), unreadable };

    console.log(`[VaultBackup] Restore complete: ${ result.inserted } inserted, ${ result.updated } updated, ${ result.skipped } unchanged`);
    this.scheduleSnapshot();

    return result;
  }
}
