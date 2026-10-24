/**
 * Passwords sync v3: Desktop > Profile "Password vault" toggle → an
 * end-to-end encrypted replica in Sulla Cloud (VAULT-E2E-DESIGN.md §4).
 *
 * Electron main only orchestrates and signs. The vault container builds and
 * applies every body (it alone holds the keys); main asks it to prepare an
 * operation, signs the returned hash with this desktop's device key
 * (purpose `vault-sync-v3`), and tells the container to send. Main never
 * sees a body, a key or plaintext.
 *
 * When:
 *   - toggle on: full upload on first enable, otherwise resume + reconcile
 *   - every 60 s: if the container reports local edits Cloud lacks, push (≥5 s debounce)
 *   - every 10 min, on unlock, and on "Sync now": pull first, then push
 *   - toggle off: pause (Cloud keeps a read-only copy); "Delete Cloud copy": signed delete
 *   - master password changed on this Desktop: rewrap the Cloud bundle on the next sync
 * Signed out, revoked, locked or a vault with no master password stop with a
 * clear status rather than failing silently.
 */

import { getDesktopDeviceId } from '../../deviceIdentity';
import { getCurrentUserId } from '../../sullaCloudAuth';
import { isCloudSignedIn } from '../cloudFetch';
import { getCloudPreferences } from '../cloudSettings';
import { signDeviceMessage } from '../deviceKey';
import { ContainerSyncError, VaultSyncContainer, type PreparedSync, type SyncOp } from './containerClient';

import Logging from '@pkg/utils/logging';

const console = Logging.background;

const RECONCILE_MS = 10 * 60_000;
const POLL_MS = 60_000;
const DEBOUNCE_MS = 5_000;
const MAX_ATTEMPTS = 3;

/** Same shape as DesktopObjectSync's status, so Profile renders it unchanged. */
export interface VaultSyncStatus {
  kind:        'vault';
  lastSyncAt?: string;
  lastError?:  string;
  skipped?:    string;
  conflicts?:  number;
  pendingPolicyReview?: number;
}

class VaultSyncV3Impl {
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<VaultSyncStatus> | null = null;
  private status: VaultSyncStatus = { kind: 'vault' };

  start(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => { this.syncIfEnabled().catch(() => undefined) }, RECONCILE_MS);
    this.pollTimer = setInterval(() => { this.pushIfDirty().catch(() => undefined) }, POLL_MS);
    this.reconcileTimer.unref?.();
    this.pollTimer.unref?.();
    this.syncIfEnabled().catch(() => undefined);
  }

  stop(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounce) clearTimeout(this.debounce);
    this.reconcileTimer = this.pollTimer = this.debounce = null;
  }

  getStatus(): VaultSyncStatus[] {
    return [this.status];
  }

  /** Call after the vault unlocks: queued local edits go up, Cloud edits come down. */
  onVaultUnlocked(): void {
    this.syncIfEnabled().catch(() => undefined);
  }

  private async syncIfEnabled(): Promise<void> {
    const prefs = await getCloudPreferences().catch(() => null);
    if (prefs?.enabled && prefs.vault) await this.syncNow();
  }

  private async pushIfDirty(): Promise<void> {
    const prefs = await getCloudPreferences().catch(() => null);
    if (!prefs?.enabled || !prefs.vault || this.inFlight || this.debounce) return;
    const local = await VaultSyncContainer.status().catch(() => null);
    if (!local?.configured || !local.pendingChanges) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.syncNow().catch(() => undefined);
    }, DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  /** Reconcile now: enable on first run, otherwise pull then push. */
  syncNow(): Promise<VaultSyncStatus> {
    this.inFlight ??= this.run().finally(() => { this.inFlight = null });
    return this.inFlight;
  }

  /** Owner turned the toggle off: Cloud keeps a read-only copy and stops accepting edits. */
  async pause(): Promise<VaultSyncStatus> {
    return this.signedOp('pause', 'Sync paused. The Cloud copy is read-only until you turn it back on.');
  }

  /** Owner asked to remove the Cloud copy. Nothing on this computer changes. */
  async deleteCloudCopy(): Promise<boolean> {
    const result = await this.signedOp('delete', undefined);
    if (result.lastError) return false;
    this.status = { kind: 'vault' };
    return true;
  }

  /**
   * Owner chose "Replace Cloud copy" (another vault already owns this
   * account's Cloud copy). Uploads this vault under a new id in one replace.
   */
  async replaceCloudCopy(): Promise<VaultSyncStatus> {
    return this.signedOp('replace', undefined);
  }

  private async identity(): Promise<{ userId: string; deviceId: string } | null> {
    if (!await isCloudSignedIn()) return null;
    const userId = await getCurrentUserId().catch(() => '');
    if (!userId) return null;
    return { userId, deviceId: await getDesktopDeviceId() };
  }

  /** prepare → sign → send for one operation. */
  private async prepareSignSend(op: SyncOp, who: { userId: string; deviceId: string }) {
    const prepared = await VaultSyncContainer.prepare(op, who.deviceId);
    if ('idle' in prepared) return { idle: true as const };
    const p = prepared as PreparedSync;
    const proof = signDeviceMessage('vault-sync-v3', [who.userId, who.deviceId, p.vaultId, p.op, p.sha256]);
    return VaultSyncContainer.send(p.handle, proof.ts, proof.signature);
  }

  private async signedOp(op: 'pause' | 'delete' | 'replace', note: string | undefined): Promise<VaultSyncStatus> {
    try {
      const who = await this.identity();
      if (!who) return this.set({ skipped: 'signed_out' });
      const local = await VaultSyncContainer.status();
      if (!local.configured && op !== 'replace') return this.set({ skipped: 'not_configured' });
      const sent = await this.prepareSignSend(op, who);
      if ('idle' in sent) return this.set({});
      if (!sent.ok) throw new ContainerSyncError(sent.error || 'cloud_error', sent.status);
      if (op === 'delete') await VaultSyncContainer.forget().catch(() => undefined);
      return this.set({ lastSyncAt: new Date().toISOString(), ...(note ? { skipped: 'paused' } : {}) });
    } catch (err) {
      return this.fail(err);
    }
  }

  private async run(): Promise<VaultSyncStatus> {
    try {
      const prefs = await getCloudPreferences();
      if (!prefs.enabled || !prefs.vault) return this.set({ skipped: 'disabled' });
      const who = await this.identity();
      if (!who) return this.set({ skipped: 'signed_out' });
      const local = await VaultSyncContainer.status();

      if (!local.configured) {
        const sent = await this.prepareSignSend('enable', who);
        if ('idle' in sent) return this.set({});
        if (!sent.ok) {
          if (sent.error === 'vault_exists') return this.set({ lastError: 'Another vault already has a Cloud copy on this account. Replace it from this desktop, or restore from Cloud.' });
          throw new ContainerSyncError(sent.error || 'cloud_error', sent.status);
        }
        console.log('[VaultSyncV3] Cloud copy created');
        return this.set({ lastSyncAt: new Date().toISOString() });
      }

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const pulled = await VaultSyncContainer.pull(who.deviceId);
        if (pulled.cloudMissing) return this.set({ lastError: 'The Cloud copy was deleted. Turn sync off and on again to upload a new one.' });
        if (attempt === 1) {
          // Master password changed here since the last upload: rewrap the Cloud bundle so the
          // browser unlocks with the new password (open browser tabs see the new generation and lock).
          const now = await VaultSyncContainer.status();
          if (now.bundleStale) {
            const rewrapped = await this.prepareSignSend('rewrap', who);
            if (!('idle' in rewrapped) && !rewrapped.ok) throw new ContainerSyncError(rewrapped.error || 'cloud_error', rewrapped.status);
          }
        }
        if (pulled.syncPaused) {
          // The toggle is on again after a pause: reopen the Cloud copy for edits.
          const resumed = await this.prepareSignSend('resume', who);
          if (!('idle' in resumed) && !resumed.ok) throw new ContainerSyncError(resumed.error || 'cloud_error', resumed.status);
        }
        const sent = await this.prepareSignSend('commit', who);
        if ('idle' in sent || sent.ok) {
          const after = await VaultSyncContainer.status().catch(() => null);
          return this.set({
            lastSyncAt: new Date().toISOString(),
            ...(pulled.conflictCopies ? { conflicts: pulled.conflictCopies } : {}),
            ...(after?.policyReviewPending ? { pendingPolicyReview: after.policyReviewPending } : {}),
          });
        }
        // head_stale / record_conflict: someone else wrote first; pull again and retry.
        if (sent.status !== 409 || sent.error === 'sync_paused') throw new ContainerSyncError(sent.error || 'cloud_error', sent.status);
      }
      return this.set({ lastError: 'Sulla Cloud kept changing during sync. It will retry shortly.' });
    } catch (err) {
      return this.fail(err);
    }
  }

  private fail(err: unknown): VaultSyncStatus {
    if (err instanceof ContainerSyncError) {
      if (err.status === 423 || err.code === 'vault_locked') return this.set({ skipped: 'vault_locked' });
      if (err.code === 'password_kdf_missing') return this.set({ lastError: 'Set a master password in the vault before turning on Cloud sync.' });
      if (err.code === 'device_revoked') return this.set({ lastError: 'This desktop was removed from your Sulla Cloud account.' });
      if (err.code === 'integrity_failed') return this.set({ lastError: 'The Cloud copy failed an integrity check. Sync stopped; nothing local changed.' });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[VaultSyncV3] sync failed: ${ message }`);
    return this.set({ lastSyncAt: this.status.lastSyncAt, lastError: message });
  }

  private set(s: Omit<VaultSyncStatus, 'kind'>): VaultSyncStatus {
    this.status = { kind: 'vault', ...s };
    return this.status;
  }
}

export const VaultSyncV3 = new VaultSyncV3Impl();
