// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Stateful chunk decision for Silero frame probabilities, including onset pre-roll and hangover. */
export class SileroChunkGate {
  private previousChunkWasSpeech = false;
  private hangoverChunks = 0;

  constructor(
    private readonly speechProbabilityThreshold = 0.5,
    private readonly minimumSpeechFrameRatio = 0.2,
    private readonly hangoverChunkCount = 2,
  ) {}

  shouldForward(probabilities: readonly number[]): boolean {
    if (!probabilities.length) return this.previousChunkWasSpeech || this.hangoverChunks > 0;
    const speechFrames = probabilities.filter(value => value >= this.speechProbabilityThreshold).length;
    const isSpeech = speechFrames / probabilities.length >= this.minimumSpeechFrameRatio;
    const forward = isSpeech || this.previousChunkWasSpeech || this.hangoverChunks > 0;
    this.previousChunkWasSpeech = isSpeech;
    this.hangoverChunks = isSpeech ? this.hangoverChunkCount : Math.max(0, this.hangoverChunks - 1);
    return forward;
  }

  reset(): void {
    this.previousChunkWasSpeech = false;
    this.hangoverChunks = 0;
  }
}
