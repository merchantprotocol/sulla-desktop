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

  constructor(private readonly driver: {
    startMic: (formats?: string[], isCancelled?: () => boolean) => Promise<any>;
    stopMic: () => Promise<void>;
    startSpeaker: () => Promise<void>;
    stopSpeaker: () => Promise<void>;
  }) {}

  async acquireMic(formats?: string[], isCancelled: () => boolean = () => false): Promise<void> {
    if (this.micHeld) return;
    if (this.micOperation) return this.micOperation;
    this.micOperation = (async() => {
      await this.driver.startMic(formats, isCancelled);
      if (!isCancelled()) this.micHeld = true;
    })();
    try { await this.micOperation; } finally { this.micOperation = null; }
  }

  async releaseMic(): Promise<void> {
    if (this.micOperation) await this.micOperation;
    if (!this.micHeld) return;
    this.micHeld = false;
    await this.driver.stopMic();
  }

  async acquireSpeaker(): Promise<void> {
    if (this.speakerHeld) return;
    if (this.speakerOperation) return this.speakerOperation;
    this.speakerOperation = (async() => {
      await this.driver.startSpeaker();
      this.speakerHeld = true;
    })();
    try { await this.speakerOperation; } finally { this.speakerOperation = null; }
  }

  async releaseSpeaker(): Promise<void> {
    if (this.speakerOperation) await this.speakerOperation;
    if (!this.speakerHeld) return;
    this.speakerHeld = false;
    await this.driver.stopSpeaker();
  }
}
