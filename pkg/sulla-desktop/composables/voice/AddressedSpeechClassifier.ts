// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface AddressedSpeechClassifier {
  isAddressed(text: string, context?: { sincePlaybackEndMs?: number; holdToTalk?: boolean }): boolean;
}

/** Cheap local gate; callers can inject a model-backed implementation later. */
export class LocalAddressedSpeechClassifier implements AddressedSpeechClassifier {
  isAddressed(text: string, context: { sincePlaybackEndMs?: number; holdToTalk?: boolean } = {}): boolean {
    if (context.holdToTalk) return true;
    const clean = text.trim();
    if (/^(?:hey\s+)?sulla\b[,:.!?]?/i.test(clean)) return true;
    return (context.sincePlaybackEndMs ?? Infinity) <= 10_000
      && /^(?:\s*)(?:what|why|how|where|when|who|can|could|would|will|should|is|are|do|does|did|tell|show|explain|give|find|make|please)\b/i.test(clean);
  }
}

/** Optional classifier adapter for a future fast-category model; disabled unless supplied. */
export class ModelAddressedSpeechClassifier implements AddressedSpeechClassifier {
  constructor(private readonly classify: (text: string) => boolean) {}
  isAddressed(text: string): boolean { return this.classify(text); }
}

/**
 * Default until a model-backed classifier ships: every hands-free utterance counts as addressed.
 * The keyword heuristic above drops natural speech that doesn't start with "Sulla" or a question
 * word ("now you don't have to keep that out of memory…"), which breaks normal voice use.
 * Overheard-speech protection currently comes from the merge cap (#2167) and the agent staying silent.
 */
export class PassThroughAddressedSpeechClassifier implements AddressedSpeechClassifier {
  isAddressed(): boolean { return true; }
}

