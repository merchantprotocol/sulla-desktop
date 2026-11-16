// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Device registration and the 45-second Cloud liveness heartbeat. */

import { getCloudPreferences } from './cloud/cloudSettings';
import { desktopDeviceIdentity } from './cloud/device/DesktopDeviceIdentity';
import { getDesktopDeviceMetadata, getDesktopDeviceId } from './deviceIdentity';

import { cloudRequest, isCloudSignedIn } from '@pkg/main/cloud/cloudFetch';
import Logging from '@pkg/utils/logging';
import { DeviceFailureDescriber, DeviceHeartbeatRetrier } from '@pkg/main/deviceHeartbeatPolicy';

const HEARTBEAT_INTERVAL_MS = 45_000;

export interface CloudDeviceState {
  registered: boolean;
  revoked: boolean;
  error?: string;
  /**
   * Cloud refused this computer's key (`device_key_mismatch`): the key file was lost or replaced, so this install can
   * never sign the rotation proof. The owner has to re-link it (`DeviceCloudService.relink`).
   */
  relinkRequired?: boolean;
  teamId?: string;
  teamName?: string;
}

interface DeviceCloudDependencies {
  cloudRequest: typeof cloudRequest;
  isCloudSignedIn: typeof isCloudSignedIn;
  getCloudPreferences: typeof getCloudPreferences;
  /** The domain DeviceIdentityService (`desktopDeviceIdentity()`): public key + /devices/register rotation proof. */
  identity: { publicKey(): Promise<string>; keyRotationProof(userId: string, nextKey?: string): Promise<{ ts: number; signature: string }> };
  getCurrentUserId: () => Promise<string>;
  getDesktopDeviceMetadata: typeof getDesktopDeviceMetadata;
  getDesktopDeviceId: typeof getDesktopDeviceId;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  logger: typeof Logging.background;
}

export type DeviceRelinkResult = { ok: true } | { ok: false; error: string };

export class DeviceCloudService {
  static readonly KEY_MISMATCH = 'device_key_mismatch';

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cachedDeviceId: string | null = null;
  private deviceState: CloudDeviceState = { registered: false, revoked: false };
  private readonly stateListeners: Array<(state: CloudDeviceState) => void> = [];
  private readonly failCounts = new Map<string, number>();
  private readonly failureDescriber = new DeviceFailureDescriber();
  private readonly heartbeatRetrier: DeviceHeartbeatRetrier;

  constructor(private readonly dependencies: DeviceCloudDependencies) {
    this.heartbeatRetrier = new DeviceHeartbeatRetrier(
      { setTimeout: dependencies.setTimeout, clearTimeout: dependencies.clearTimeout },
      () => this.sendHeartbeat(),
    );
  }

  async register(): Promise<string | null> {
    try {
      const meta = await this.dependencies.getDesktopDeviceMetadata();
      const publicKey = await this.dependencies.identity.publicKey();
      const proof = await this.registrationProof();
      const res = await this.postJson('/devices/register', {
        deviceId: meta.deviceId,
        deviceType: meta.deviceType,
        platform: meta.platform,
        model: meta.model,
        hostname: meta.hostname,
        name: meta.name,
        osVersion: meta.osVersion,
        appVersion: meta.appVersion,
        publicKey,
        ...(proof ? { proof } : {}),
        ...(await this.reportedPreferences()),
      });
      if (!res.ok) {
        if (res.status === 409) {
          this.dependencies.logger.warn(`[DevicesApi] register refused: ${ res.data?.error }`);
          const error = res.data?.error || 'registration_refused';
          this.setDeviceState({ registered: false, revoked: false, error, ...(error === DeviceCloudService.KEY_MISMATCH ? { relinkRequired: true } : {}) });
        }
        return null;
      }
      this.setDeviceState({
        registered: true,
        revoked: !!res.data?.revoked,
        ...(typeof (res.data?.teamName ?? res.data?.team_name ?? res.data?.organizationName) === 'string' ? { teamName: res.data.teamName ?? res.data.team_name ?? res.data.organizationName } : {}),
        ...(typeof (res.data?.teamId ?? res.data?.team_id) === 'string' ? { teamId: res.data.teamId ?? res.data.team_id } : {}),
      });
      this.cachedDeviceId = meta.deviceId;
      this.dependencies.logger.log(`[DevicesApi] registered ${ meta.deviceId }`);
      return meta.deviceId;
    } catch (error) {
      this.dependencies.logger.log(`[DevicesApi] register failed: ${ error }`);
      return null;
    }
  }

  /**
   * Re-link after `device_key_mismatch` (the domain DeviceRegistrationPolicy lost-key rule): the owner removes this
   * computer's Cloud row, then it registers again with the key it holds now. Cloud accepts that as a release, so vault
   * approval starts over. Only allowed while Cloud is refusing the key.
   */
  async relink(): Promise<DeviceRelinkResult> {
    if (!this.deviceState.relinkRequired) return { ok: false, error: 'relink_not_required' };
    try {
      if (!await this.dependencies.isCloudSignedIn()) return { ok: false, error: 'not_signed_in' };
      const deviceId = await this.dependencies.getDesktopDeviceId();
      const removed = await this.dependencies.cloudRequest('DELETE', `/devices/${ encodeURIComponent(deviceId) }`);
      if (!removed.ok) return { ok: false, error: `remove_failed_${ removed.status }` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const registered = await this.register();
    if (registered && this.deviceState.registered) return { ok: true };

    return { ok: false, error: this.deviceState.error || 'registration_failed' };
  }

  async heartbeat(): Promise<void> { await this.heartbeatRetrier.run(); }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    void this.heartbeat();
    this.heartbeatTimer = this.dependencies.setInterval(() => { void this.heartbeat(); }, HEARTBEAT_INTERVAL_MS);
  }

  getState(): CloudDeviceState { return this.deviceState; }

  onStateChange(listener: (state: CloudDeviceState) => void): () => void {
    this.stateListeners.push(listener);
    return () => {
      const index = this.stateListeners.indexOf(listener);
      if (index >= 0) this.stateListeners.splice(index, 1);
    };
  }

  stopHeartbeat(): void {
    this.heartbeatRetrier.stop();
    if (this.heartbeatTimer) this.dependencies.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.cachedDeviceId = null;
  }

  private setDeviceState(next: CloudDeviceState): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.deviceState);
    this.deviceState = next;
    if (!changed) return;
    for (const listener of this.stateListeners) {
      try { listener(next); } catch { /* listener isolation */ }
    }
  }

  /** `proof` for /devices/register, signed by the key this install holds; omitted when no user id is available. */
  private async registrationProof(): Promise<{ ts: number; signature: string } | null> {
    let userId = '';
    try { userId = await this.dependencies.getCurrentUserId() } catch { /* not signed in: register is skipped anyway */ }
    if (!userId) return null;

    return this.dependencies.identity.keyRotationProof(userId);
  }

  private async reportedPreferences(): Promise<{ remoteAccess: 'enabled' | 'disabled'; syncSettings: Record<string, boolean> } | Record<string, never>> {
    try {
      const preferences = await this.dependencies.getCloudPreferences();
      return {
        remoteAccess: preferences.remoteAccess ? 'enabled' : 'disabled',
        syncSettings: Object.fromEntries(Object.entries(preferences).filter(([key]) => key !== 'remoteAccess')),
      };
    } catch { return {}; }
  }

  private async postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: any; transient: boolean }> {
    try {
      if (!await this.dependencies.isCloudSignedIn()) return { ok: false, status: 0, data: null, transient: false };
      const response = await this.dependencies.cloudRequest('POST', path, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        const transient = response.status >= 500 || response.status === 408 || response.status === 429;
        this.recordFailure(path, `code=http_error status=${ response.status } stage=upstream`, transient);
        return { ok: false, status: response.status, data, transient };
      }
      const failures = this.failCounts.get(path);
      if (failures) this.dependencies.logger.log(`[DevicesApi] ${ path } recovered after ${ failures } consecutive failures`);
      this.failCounts.delete(path);
      return { ok: true, status: response.status, data: await response.json().catch(() => null), transient: false };
    } catch (error) {
      const failure = this.failureDescriber.describe(error);
      this.recordFailure(path, failure.detail, failure.transient);
      return { ok: false, status: failure.status, data: null, transient: failure.transient };
    }
  }

  private recordFailure(path: string, detail: string, transient: boolean): void {
    const failures = (this.failCounts.get(path) ?? 0) + 1;
    this.failCounts.set(path, failures);
    if (failures === 1 || failures % 40 === 0) {
      this.dependencies.logger.log(`[DevicesApi] ${ path } failed: ${ detail } transient=${ transient }${ failures > 1 ? ` (${ failures } consecutive failures, logging every 40th)` : '' }`);
    }
  }

  private async sendHeartbeat(): Promise<{ ok: boolean; transient: boolean }> {
    try {
      const deviceId = this.cachedDeviceId ?? (await this.dependencies.getDesktopDeviceId());
      this.cachedDeviceId = deviceId;
      const response = await this.postJson('/devices/heartbeat', { deviceId, ...(await this.reportedPreferences()) });
      if (response.ok && typeof response.data?.revoked === 'boolean' && response.data.revoked !== this.deviceState.revoked) {
        this.setDeviceState({ ...this.deviceState, revoked: response.data.revoked });
      }
      return { ok: response.ok, transient: response.transient };
    } catch { return { ok: false, transient: true }; }
  }
}

export const DevicesCloudApi = new DeviceCloudService({
  cloudRequest,
  isCloudSignedIn,
  getCloudPreferences,
  get identity() { return desktopDeviceIdentity() },
  // Lazy: sullaCloudAuth imports this module.
  getCurrentUserId: async() => (await import('./sullaCloudAuth')).getCurrentUserId(),
  getDesktopDeviceMetadata,
  getDesktopDeviceId,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
  logger: Logging.background,
});
