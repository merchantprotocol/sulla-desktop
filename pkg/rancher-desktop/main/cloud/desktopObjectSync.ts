import { decisionService } from '@pkg/agent/services/DecisionService';
/**
 * Opt-in desktop → cloud copies of the vault and Projects.
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
 * Projects (cloudSyncProjects): a read-only snapshot of projects, epics,
 * tasks and effective lanes so the cloud dashboard can show work while
 * this machine is off.
 *
 * Uploads are signed with the device key (sync-upload purpose) over the
 * body's SHA-256, and skipped when nothing changed.
 */

import crypto from 'crypto';

import { getDesktopDeviceId } from '../deviceIdentity';
import { getCurrentAccessToken, getCurrentUserId } from '../sullaCloudAuth';
import { CLOUD_API_BASE } from './cloudEndpoints';
import { getCloudPreferences } from './cloudSettings';
import { signDeviceMessage } from './deviceKey';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { WorkItemsModel } from '@pkg/agent/database/models/WorkItemsModel';
import { WorkLaneDefinitionModel } from '@pkg/agent/database/models/WorkLaneDefinitionModel';
import { getVaultBackupService, type VaultSnapshot } from '@pkg/agent/services/VaultBackupService';
import { getVaultKeyService } from '@pkg/agent/services/VaultKeyService';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

export type ObjectKind = 'vault' | 'projects';
const INTERVAL_MS = 10 * 60_000;
const LAST_HASH_KEY: Record<ObjectKind, string> = { vault: 'cloudSyncVaultLastHash', projects: 'cloudSyncProjectsLastHash' };

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

export async function buildProjectsBody(): Promise<{ body: string; dedupe: string }> {
  const projects = (await WorkItemsModel.listProjects({ includeDone: true, limit: 1000 })).filter((p: any) => !p.archived);
  const [epics, tasks] = await Promise.all([
    WorkItemsModel.listEpics({ includeDone: true, limit: 5000 }),
    WorkItemsModel.listTasks({ includeDone: true, limit: 10000 }),
  ]);
  const lanes: Record<string, unknown> = {};
  for (const p of projects) {
    try { lanes[(p as any).id] = await WorkLaneDefinitionModel.resolveEffective((p as any).id) } catch { /* lanes optional */ }
  }
  const content = { projects, epics, tasks, lanes, decisions: await decisionService.list() };
  const dedupe = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return { body: JSON.stringify({ format: 'sulla-projects-snapshot', version: 1, createdAt: new Date().toISOString(), ...content }), dedupe };
}

class DesktopObjectSyncImpl {
  private unsubscribeDecisions: (() => void) | undefined;
  private decisionSyncTimer: ReturnType<typeof setTimeout> | undefined;
  private timer:  ReturnType<typeof setInterval> | null = null;
  private inFlight = new Map<ObjectKind, Promise<ObjectSyncStatus>>();
  private status: Record<ObjectKind, ObjectSyncStatus> = { vault: { kind: 'vault' }, projects: { kind: 'projects' } };

  start(): void {
    if (this.timer) return;
    this.unsubscribeDecisions = decisionService.subscribe(() => {
      clearTimeout(this.decisionSyncTimer);
      this.decisionSyncTimer = setTimeout(async() => {
        await this.inFlight.get('projects')?.catch(() => undefined);
        await this.syncNow('projects');
      }, 250);
      this.decisionSyncTimer.unref?.();
    });
    this.timer = setInterval(() => { this.syncEnabled().catch(() => undefined) }, INTERVAL_MS);
    this.timer.unref?.();
    this.syncEnabled().catch(() => undefined);
  }

  stop(): void {
    this.unsubscribeDecisions?.();
    this.unsubscribeDecisions = undefined;
    clearTimeout(this.decisionSyncTimer);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): ObjectSyncStatus[] {
    return [this.status.vault, this.status.projects];
  }

  async syncEnabled(): Promise<void> {
    const prefs = await getCloudPreferences().catch(() => null);
    if (!prefs) return;
    if (prefs.vault) await this.syncNow('vault');
    if (prefs.projects) await this.syncNow('projects');
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
    const token = await getCurrentAccessToken();
    if (!token) return false;
    const deviceId = await getDesktopDeviceId();
    const res = await fetch(`${ CLOUD_API_BASE }/desktop-sync/${ encodeURIComponent(deviceId) }/${ kind }`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${ token }` },
    });
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
      const token = await getCurrentAccessToken();
      const userId = await getCurrentUserId();
      if (!token || !userId) return this.set(kind, { skipped: 'signed_out' });

      const built = kind === 'vault' ? await buildSealedVaultBody() : await buildProjectsBody();
      if (!built) return this.set(kind, { skipped: 'vault_locked' });
      const last = String(await SullaSettingsModel.get(LAST_HASH_KEY[kind], '') ?? '');
      if (!force && last === built.dedupe) return this.set(kind, { lastSyncAt: this.status[kind].lastSyncAt, skipped: 'unchanged' });

      const deviceId = await getDesktopDeviceId();
      const bytes = Buffer.from(built.body, 'utf8');
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      const proof = signDeviceMessage('sync-upload', [userId, deviceId, kind, sha]);
      const res = await fetch(`${ CLOUD_API_BASE }/desktop-sync/${ encodeURIComponent(deviceId) }/${ kind }`, {
        method:  'PUT',
        headers: {
          'Content-Type':             'application/json',
          Authorization:              `Bearer ${ token }`,
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
