// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Tracks the only voice input eligible for replacement while its backend reply is pending. */
export const VOICE_MERGE_WINDOW_MS = 8_000;
export const MAX_VOICE_MERGES = 2;

export class PendingVoiceTurn {
  private submittedText = '';
  private audioStarted = false;
  private submittedAt = 0;
  private mergeCount = 0;

  mergeWithNext(text: string, runPending: boolean, now = Date.now()): string | null {
    if (!this.submittedText || !runPending || this.audioStarted ||
        now - this.submittedAt > VOICE_MERGE_WINDOW_MS || this.mergeCount >= MAX_VOICE_MERGES) return null;
    this.mergeCount += 1;
    return `${ this.submittedText } ${ text }`;
  }

  submitted(text: string, merged = false, now = Date.now()): void {
    if (!merged) {
      this.submittedAt = now;
      this.mergeCount = 0;
    }
    this.submittedText = text;
    this.audioStarted = false;
  }
  markAudioStarted(): void { this.audioStarted = true; }
  clear(): void { this.submittedText = ''; this.audioStarted = false; this.submittedAt = 0; this.mergeCount = 0; }
}
