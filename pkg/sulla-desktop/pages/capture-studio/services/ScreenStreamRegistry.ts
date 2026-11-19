// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Owns one independently stoppable screen stream per Capture Studio source. */
export class ScreenStreamRegistry {
  private readonly streams = new Map<string, MediaStream>();

  get(sourceId: string): MediaStream | null { return this.streams.get(sourceId) ?? null }

  set(sourceId: string, stream: MediaStream): void {
    this.release(sourceId);
    this.streams.set(sourceId, stream);
  }

  release(sourceId: string): void {
    const stream = this.streams.get(sourceId);
    if (!stream) return;
    this.streams.delete(sourceId);
    stream.getTracks().forEach(track => track.stop());
  }

  releaseAll(): void {
    for (const sourceId of [...this.streams.keys()]) this.release(sourceId);
  }

  entries(): [string, MediaStream][] { return [...this.streams.entries()] }
}
