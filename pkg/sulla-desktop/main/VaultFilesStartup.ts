// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type VaultFilesStartupPhase =
  | 'vault-locked'
  | 'vault-unlocking'
  | 'files-unlocking'
  | 'files-unlocked'
  | 'mount-token-written'
  | 'mounted'
  | 'degraded';

export interface VaultFilesStartupSnapshot {
  phase:VaultFilesStartupPhase;
  reason?:string;
  vaultUnlocked:boolean;
  filesUnlocked:boolean;
  mountTokenWritten:boolean;
  ready:boolean;
}

/** Instance-owned startup state; readiness requires an unlocked Files service and a written token. */
export class VaultFilesStartup {
  private phaseValue:VaultFilesStartupPhase = 'vault-locked';
  private reason?:string;
  private vaultUnlockedValue = false;
  private filesUnlockedValue = false;
  private mountTokenWrittenValue = false;
  private mountedValue = false;
  /** False when the guest FUSE mount is disabled by design (native rollout off). */
  private mountRequiredValue = true;

  vaultLocked():void {
    this.vaultUnlockedValue = false;
    this.filesUnlockedValue = false;
    this.mountTokenWrittenValue = false;
    this.mountedValue = false;
    this.mountRequiredValue = true;
    this.reason = undefined;
    this.phaseValue = 'vault-locked';
  }

  vaultUnlocking():void { this.phaseValue = 'vault-unlocking' }
  filesUnlocking():void { this.vaultUnlockedValue = true; this.phaseValue = 'files-unlocking' }

  filesUnlocked():void {
    this.vaultUnlockedValue = true;
    this.filesUnlockedValue = true;
    this.phaseValue = this.mountedValue ? 'mounted' : this.mountTokenWrittenValue ? 'mount-token-written' : 'files-unlocked';
    this.reason = undefined;
  }

  mountTokenWritten():void {
    if (!this.filesUnlockedValue || !this.vaultUnlockedValue) return;
    this.mountTokenWrittenValue = true;
    this.phaseValue = this.mountedValue ? 'mounted' : 'mount-token-written';
  }

  mounted():void {
    if (!this.isReady()) return;
    this.mountedValue = true;
    if (this.phaseValue === 'degraded') return;
    this.phaseValue = 'mounted';
    this.reason = undefined;
  }

  /** Files is usable without the guest mount when the mount is disabled by design. */
  mountNotRequired():void {
    this.mountRequiredValue = false;
  }

  degrade(reason:string):void {
    this.phaseValue = 'degraded';
    this.reason = reason;
  }

  isReady():boolean {
    return this.vaultUnlockedValue && this.filesUnlockedValue && (this.mountTokenWrittenValue || !this.mountRequiredValue);
  }

  snapshot():VaultFilesStartupSnapshot {
    return {
      phase: this.phaseValue,
      ...(this.reason ? { reason: this.reason } : {}),
      vaultUnlocked: this.vaultUnlockedValue,
      filesUnlocked: this.filesUnlockedValue,
      mountTokenWritten: this.mountTokenWrittenValue,
      ready: this.isReady(),
    };
  }
}
