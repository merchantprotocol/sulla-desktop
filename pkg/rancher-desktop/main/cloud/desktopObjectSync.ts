/**
 * Opt-in desktop → cloud copies of the vault.
 *
 * Vault (cloudSyncVault): zero-knowledge. The ciphertext-only snapshot
 * VaultBackupService already builds would still show which services and
 * account ids exist, so we seal the whole row set once more under the
 * vault key. The cloud receives only:
 *   - the wrapped key material (useless without the master password or
 *     recovery key),
 *   - a row count, and
 *   - one `$VAULT$` blob.
 * The owner's browser (or another desktop) opens it with the master
 * password; the server can't.
 *
 * Uploads are signed with the device key (sync-upload purpose) over the
 * body's SHA-256, and skipped when nothing changed.
 */

import crypto from 'crypto';

import { getDesktopDeviceId } from '../deviceIdentity';
import { cloudRequest, isCloudSignedIn } from './cloudFetch';
import { getCurrentUserId } from '../sullaCloudAuth';
import { getCloudPreferences } from './cloudSettings';
import { signDeviceMessage } from './deviceKey';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getVaultBackupService, type VaultSnapshot } from '@pkg/agent/services/VaultBackupService';
import { getVaultKeyService } from '@pkg/agent/services/VaultKeyService';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

export type ObjectKind = 'vault';
const INTERVAL_MS = 10 * 60_000;
const LAST_HASH_KEY: Record<ObjectKind, string> = { vault: 'cloudSyncVaultLastHash' };

export interface ObjectSyncStatus {
  kind:        ObjectKind;
  lastSyncAt?: string;
  lastError?:  string;
  skipped?:    string;
}

/** Build the sealed vault body, or null (vault missing or locked). Exported for tests. */
export async function buildSealedVaultBody(): Promise<{ body: string; dedupe: string } | null> {
  const vault = getVaultKeyService();
  if (!vault.isSetUp() || !vault.isUnlocked()) return null;
  const snapshot = JSON.parse(await getVaultBackupService().buildExport()) as VaultSnapshot;
  const body = JSON.stringify({
    format:      'sulla-vault-snapshot',
    version:     2,
    createdAt:   snapshot.createdAt,
    rowCount:    snapshot.rows.length,
    keyMaterial: snapshot.keyMaterial,
    rows:        [],
    sealed:      vault.encrypt(JSON.stringify(snapshot.rows)),
  });
  // rowsSha256 covers ciphertext rows + key material; stable while nothing changes.
  return { body, dedupe: snapshot.rowsSha256 };
}



class DesktopObjectSyncImpl {
  private timer:  ReturnType<typeof setInterval> | null = null;
  private inFlight = new Map<ObjectKind, Promise<ObjectSyncStatus>>();
  private status: Record<ObjectKind, ObjectSyncStatus> = { vault: { kind: 'vault' } };

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.syncEnabled().catch(() => undefined) }, INTERVAL_MS);
    this.timer.unref?.();
    this.syncEnabled().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): ObjectSyncStatus[] {
    return [this.status.vault];
  }

  async syncEnabled(): Promise<void> {
    const prefs = await getCloudPreferences().catch(() => null);
    if (!prefs) return;
    if (prefs.vault) await this.syncNow('vault');
  }

  syncNow(kind: ObjectKind, force = false): Promise<ObjectSyncStatus> {
    const existing = this.inFlight.get(kind);
    if (existing) return existing;
    const run = this.run(kind, force).finally(() => this.inFlight.delete(kind));
    this.inFlight.set(kind, run);
    return run;
  }

  /** Owner turned the sync off and asked to remove the cloud copy. */
  async deleteCloudCopy(kind: ObjectKind): Promise<boolean> {
    if (!await isCloudSignedIn()) return false;
    const deviceId = await getDesktopDeviceId();
    const res = await cloudRequest('DELETE', `/desktop-sync/${ encodeURIComponent(deviceId) }/${ kind }`);
    if (res.ok) {
      await SullaSettingsModel.set(LAST_HASH_KEY[kind], '', 'string');
      this.status[kind] = { kind };
    }
    return res.ok;
  }

  private async run(kind: ObjectKind, force: boolean): Promise<ObjectSyncStatus> {
    try {
      const prefs = await getCloudPreferences();
      if (!prefs[kind]) return this.set(kind, { skipped: 'disabled' });
      const userId = await getCurrentUserId();
      if (!await isCloudSignedIn() || !userId) return this.set(kind, { skipped: 'signed_out' });

      const built = await buildSealedVaultBody();
      if (!built) return this.set(kind, { skipped: 'vault_locked' });
      const last = String(await SullaSettingsModel.get(LAST_HASH_KEY[kind], '') ?? '');
      if (!force && last === built.dedupe) return this.set(kind, { lastSyncAt: this.status[kind].lastSyncAt, skipped: 'unchanged' });

      const deviceId = await getDesktopDeviceId();
      const bytes = Buffer.from(built.body, 'utf8');
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      const proof = signDeviceMessage('sync-upload', [userId, deviceId, kind, sha]);
      const res = await cloudRequest('PUT', `/desktop-sync/${ encodeURIComponent(deviceId) }/${ kind }`, {
        headers: {
          'Content-Type':             'application/json',
          'X-Sulla-Timestamp':        String(proof.ts),
          'X-Sulla-Device-Signature': proof.signature,
        },
        body: bytes,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `upload failed (${ res.status })`);
      }
      await SullaSettingsModel.set(LAST_HASH_KEY[kind], built.dedupe, 'string');
      console.log(`[DesktopObjectSync] ${ kind } copy uploaded (${ bytes.length } bytes)`);
      return this.set(kind, { lastSyncAt: new Date().toISOString() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[DesktopObjectSync] ${ kind } sync failed: ${ message }`);
      return this.set(kind, { lastSyncAt: this.status[kind].lastSyncAt, lastError: message });
    }
  }

  private set(kind: ObjectKind, s: Omit<ObjectSyncStatus, 'kind'>): ObjectSyncStatus {
    this.status[kind] = { kind, ...s };
    return this.status[kind];
  }
}

export const DesktopObjectSync = new DesktopObjectSyncImpl();
