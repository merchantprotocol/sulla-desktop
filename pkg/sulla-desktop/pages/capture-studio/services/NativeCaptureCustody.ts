// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { SpeakerCaptureIntegrity } from './SpeakerCaptureIntegrity';

/** Owns cancellation tokens for asynchronous native display-audio requests. */
export class NativeCaptureCustody {
  private generation = 0;

  constructor(private readonly integrity: SpeakerCaptureIntegrity) {}

  begin(): number {
    return ++this.generation;
  }

  release(): void {
    this.generation += 1;
  }

  accept(requestGeneration: number, stream: MediaStream): boolean {
    if (requestGeneration === this.generation) return true;
    this.integrity.stopTracks(stream.getTracks());
    return false;
  }
}
