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
    startSpeaker: () => Promise<void>;
    stopSpeaker: () => Promise<void>;
  }, private readonly isClosing: () => boolean = () => false) {}

  async acquireMic(formats?: string[], isCancelled: () => boolean = () => false): Promise<void> {
    if (this.micReleaseOperation) await this.micReleaseOperation;
    if (this.micHeld) return;
    if (this.micOperation) return this.micOperation;
    this.micOperation = (async() => {
      try {
        // Do not delegate cancellation to startMic: its helper performs its own
        // stop, but the lifecycle guard can then reject after that stop and make
        // cleanup release the same owner twice. Keep cancellation custody here.
        await this.driver.startMic(formats);
        if (isCancelled()) {
          await this.driver.stopMic();
          return;
        }
        this.micHeld = true;
      } catch (error) {
        // A lifecycle guard can reject after the driver already acquired its
        // holder. Cleanup runs after this operation settles, so preserve custody.
        if (isCancelled() || this.isClosing()) this.micHeld = true;
        throw error;
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
      try {
        await this.driver.startSpeaker();
        this.speakerHeld = true;
      } catch (error) {
        if (this.isClosing()) this.speakerHeld = true;
        throw error;
      }
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
