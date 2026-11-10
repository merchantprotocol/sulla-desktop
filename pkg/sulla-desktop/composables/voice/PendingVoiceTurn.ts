// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Tracks the only voice input eligible for replacement while its backend reply is pending. */
export class PendingVoiceTurn {
  private submittedText = '';
  private audioStarted = false;

  mergeWithNext(text: string, runPending: boolean): string | null {
    if (!this.submittedText || !runPending || this.audioStarted) return null;
    return `${ this.submittedText } ${ text }`;
  }

  submitted(text: string): void { this.submittedText = text; this.audioStarted = false; }
  markAudioStarted(): void { this.audioStarted = true; }
  clear(): void { this.submittedText = ''; this.audioStarted = false; }
}
