// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Tracks per-writer pause time and converts it to PCM silence without touching the shared audio driver. */
export class PcmPauseTimeline {
  private pausedAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  pause(): boolean {
    if (this.pausedAt !== null) return false;
    this.pausedAt = this.now();
    return true;
  }

  resume(sampleRate: number, bytesPerSample: number): number {
    if (this.pausedAt === null) return 0;
    const durationMs = Math.max(0, this.now() - this.pausedAt);
    this.pausedAt = null;
    return Math.floor(sampleRate * durationMs / 1000) * bytesPerSample;
  }

  reset(): void {
    this.pausedAt = null;
  }
}
