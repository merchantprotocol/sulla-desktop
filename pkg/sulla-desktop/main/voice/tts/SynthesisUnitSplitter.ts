// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { splitForSynthesis } from '../../../composables/voice/speechText';
import type { SpeechUnitSplitter } from './KokoroSynthesizer';

/** Sentence-level splitter with no total length cap; the existing renderer splitter does the work. */
export class SynthesisUnitSplitter implements SpeechUnitSplitter {
  split(text: string): string[] {
    return splitForSynthesis(text);
  }
}
