// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { KokoroSynthesis, KokoroSynthesizer } from './KokoroSynthesizer';

/** Thin boundary over the existing kokoroTts.ts path. Model, sidecar and download logic stay untouched. */
export class KokoroModuleSynthesizer implements KokoroSynthesizer {
  /** WAV header: sample rate is a little-endian uint32 at byte offset 24. */
  private static readonly SAMPLE_RATE_OFFSET = 24;

  async synthesize(text: string, voiceKey: string | null, speed: number): Promise<KokoroSynthesis> {
    const { synthesizeKokoro } = await import('@pkg/main/voice/kokoroTts');
    const wav = await synthesizeKokoro(text, voiceKey, speed);

    return {
      data: new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength),
      sampleRate: wav.readUInt32LE(KokoroModuleSynthesizer.SAMPLE_RATE_OFFSET),
    };
  }
}
