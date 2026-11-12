// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Something the gate can switch on and off (the secure channel / relay, vault sync, files sync). */
export interface DeviceBoundService {
  start(): void;
  stop(): void;
}

/** What the gate reads from `DevicesCloudApi.getState()`. */
export interface DeviceGateState {
  registered:      boolean;
  revoked:         boolean;
  relinkRequired?: boolean;
}

/**
 * The rule for what may run while Cloud does not trust this computer. A revoked device (removed from the dashboard)
 * or one whose key Cloud refuses (`device_key_mismatch`) must not open the relay channel or push vault/files sync:
 * Cloud would refuse every signed request anyway, and vault sync must never keep retrying with a key Cloud rejects.
 * When the device is trusted again (restored, or re-linked) the channel comes back and sync follows the preferences.
 */
export class DeviceSyncGate {
  constructor(
    private readonly services: { channel: DeviceBoundService; vault: DeviceBoundService; files: DeviceBoundService },
    private readonly enabled: (kind: 'vault' | 'files') => Promise<boolean>,
  ) {}

  /** True when device-signed sync may run for this state. */
  allowsSync(state: DeviceGateState): boolean {
    return !state.revoked && !state.relinkRequired;
  }

  /** React to a device state change. */
  async apply(state: DeviceGateState, signedIn: boolean): Promise<void> {
    if (!this.allowsSync(state)) {
      this.services.channel.stop();
      this.services.vault.stop();
      this.services.files.stop();

      return;
    }
    if (!signedIn || !state.registered) return;
    this.services.channel.start();
    const [vault, files] = await Promise.all([this.enabled('vault').catch(() => false), this.enabled('files').catch(() => false)]);
    if (vault) this.services.vault.start();
    if (files) this.services.files.start();
  }
}
