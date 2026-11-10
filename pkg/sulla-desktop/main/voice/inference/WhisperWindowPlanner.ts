// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Splits 16 kHz audio into non-overlapping Whisper windows, preferring quiet frame boundaries. */
export class WhisperWindowPlanner {
  static readonly sampleRate = 16_000;
  static readonly maxWindowSamples = 30 * WhisperWindowPlanner.sampleRate;
  static readonly frameSamples = 20 * WhisperWindowPlanner.sampleRate / 1000;
  static readonly searchSamples = 2 * WhisperWindowPlanner.sampleRate;

  plan(samples: Float32Array): Float32Array[] {
    const windows: Float32Array[] = [];
    for (let start = 0; start < samples.length;) {
      const hardEnd = Math.min(start + WhisperWindowPlanner.maxWindowSamples, samples.length);
      const end = hardEnd === samples.length ? hardEnd : this.quietBoundary(samples, start, hardEnd);
      windows.push(samples.slice(start, end));
      start = end;
    }
    return windows;
  }

  private quietBoundary(samples: Float32Array, start: number, hardEnd: number): number {
    const frame = WhisperWindowPlanner.frameSamples;
    const earliest = Math.max(start + frame, hardEnd - WhisperWindowPlanner.searchSamples);
    const firstAligned = Math.ceil(earliest / frame) * frame;
    let best = hardEnd;
    let bestEnergy = Infinity;
    for (let end = firstAligned; end <= hardEnd; end += frame) {
      const frameStart = end - frame;
      let energy = 0;
      for (let i = frameStart; i < end; i++) energy += samples[i] * samples[i];
      if (energy < bestEnergy) { bestEnergy = energy; best = end; }
    }
    return best;
  }
}
