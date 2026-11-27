// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { TranscriptEvent } from './service/whisper-transcribe';

export interface VoiceTranscriptTarget {
  isDestroyed(): boolean;
  send(channel: string, ...args: any[]): void;
}

/** Delivers a transcription event from the main process to a renderer. */
export class VoiceTranscriptDelivery {
  constructor(private readonly target: VoiceTranscriptTarget) {}

  deliver(event: TranscriptEvent): void {
    if (!this.target.isDestroyed()) this.target.send('gateway-transcript', event);
  }
}
