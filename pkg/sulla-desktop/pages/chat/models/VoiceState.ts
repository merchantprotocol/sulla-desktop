// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { MessageId } from '../types/chat';

export type VoiceState =
  | { phase: 'idle' }
  | {
    phase: 'recording'; startedAt: number; interimMessageId: MessageId; level: number; speaking: boolean;
    /** Hold-to-talk (Space) rather than hands-free. */
    ptt?: boolean;
    /** Released — the final transcription is running; the message sends when it lands. */
    finishing?: boolean;
  }
  | { phase: 'playing';   refId: MessageId; startedAt: number; endsAt?: number };

export const voiceIdle = (): VoiceState => ({ phase: 'idle' });

export const isRecording = (v: VoiceState): boolean => v.phase === 'recording';
export const isPlaying   = (v: VoiceState): boolean => v.phase === 'playing';
