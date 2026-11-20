// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Tracks Capture Studio's own audio-driver holds so source removal cannot leak
 * its ref-counted mic/BlackHole ownership or release it twice. */
export class CaptureAudioDriverOwnership {
  private micHeld = false;
  private speakerHeld = false;
  private micOperation: Promise<void> | null = null;
  private speakerOperation: Promise<void> | null = null;
  private micReleaseOperation: Promise<void> | null = null;
  private speakerReleaseOperation: Promise<void> | null = null;

  constructor(private readonly driver: {
    startMic: (formats?: string[], isCancelled?: () => boolean) => Promise<any>;
    stopMic: () => Promise<void>;
    startSpeaker: () => Promise<any>;
    stopSpeaker: () => Promise<void>;
  }) {}

  async acquireMic(formats?: string[], isCancelled: () => boolean = () => false): Promise<void> {
    if (this.micReleaseOperation) await this.micReleaseOperation;
    if (this.micHeld) return;
    if (this.micOperation) return this.micOperation;
    this.micOperation = (async() => {
        // Do not delegate cancellation to startMic: its helper performs its own
        // stop, but the lifecycle guard can then reject after that stop and make
        // cleanup release the same owner twice. Keep cancellation custody here.
        const result = await this.driver.startMic(formats);
        // Record custody only from the driver's explicit successful receipt.
        // An exception may happen before acquisition; close state says nothing
        // about whether this owner actually obtained a ref-counted hold.
        if (result?.ok === false) return;
        this.micHeld = true;
        if (isCancelled()) {
          await this.driver.stopMic();
          this.micHeld = false;
          return;
        }
    })();
    try { await this.micOperation; } finally { this.micOperation = null; }
  }

  async releaseMic(): Promise<void> {
    if (this.micOperation) await this.micOperation.catch(() => undefined);
    if (this.micReleaseOperation) return this.micReleaseOperation;
    if (!this.micHeld) return;
    this.micReleaseOperation = (async() => {
      await this.driver.stopMic();
      this.micHeld = false;
    })();
    try { await this.micReleaseOperation; } finally { this.micReleaseOperation = null; }
  }

  async acquireSpeaker(): Promise<void> {
    if (this.speakerReleaseOperation) await this.speakerReleaseOperation;
    if (this.speakerHeld) return;
    if (this.speakerOperation) return this.speakerOperation;
    this.speakerOperation = (async() => {
        const result = await this.driver.startSpeaker();
        if ((result as any)?.ok === false) return;
        this.speakerHeld = true;
    })();
    try { await this.speakerOperation; } finally { this.speakerOperation = null; }
  }

  async releaseSpeaker(): Promise<void> {
    if (this.speakerOperation) await this.speakerOperation.catch(() => undefined);
    if (this.speakerReleaseOperation) return this.speakerReleaseOperation;
    if (!this.speakerHeld) return;
    this.speakerReleaseOperation = (async() => {
      await this.driver.stopSpeaker();
      this.speakerHeld = false;
    })();
    try { await this.speakerReleaseOperation; } finally { this.speakerReleaseOperation = null; }
  }
}
