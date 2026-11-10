// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** One synthesized sentence: a 16-bit mono WAV container and its sample rate. */
export interface KokoroSynthesis {
  data: Uint8Array;
  sampleRate: number;
}

/** Narrow seam over the Kokoro engine so the adapter can be tested without the sidecar or model. */
export interface KokoroSynthesizer {
  synthesize(text: string, voiceKey: string | null, speed: number): Promise<KokoroSynthesis>;
}

/** Splits a reply into synthesis units, each spoken and yielded independently. */
export interface SpeechUnitSplitter {
  split(text: string): string[];
}
