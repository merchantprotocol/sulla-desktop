// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SelfEchoFilter } from './SelfEchoFilter';
import { TranscriptNoiseFilter } from './VoiceTurnAccumulator';

/** Returns only user words left after removing Sulla's playback from mixed transcripts. */
export class VoiceBargeInPolicy {
  constructor(private readonly echo: SelfEchoFilter, private readonly noise: TranscriptNoiseFilter) {}

  userWords(transcript: string): string {
    const words = this.echo.stripEchoSpans(transcript).trim();
    return words && !this.noise.isNoise(words) && !this.echo.isEcho(words) ? words : '';
  }
}
