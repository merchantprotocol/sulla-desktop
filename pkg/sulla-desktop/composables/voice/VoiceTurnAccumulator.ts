// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { HeuristicEndOfTurnDetector, TurnBuffer, type EndOfTurnDetector } from './ConversationTurnPolicy';

/**
 * VoiceTurnAccumulator — the shared state machine that turns a stream of
 * `gateway-transcript` events into ONE committed voice message per utterance.
 *
 * Both voice surfaces (useVoiceSession for the classic chat, VoiceSessionAdapter
 * for the new chat page) used to duplicate this logic — and the duplication is
 * exactly how the two drifted (the 2000ms commit-timer bug lived in both copies).
 * This module owns the shared behavior; each surface supplies UI callbacks:
 *
 *   - transcript_partial → accumulated into a live-display string (onInterim), NOT committed.
 *   - transcript_turn    → the authoritative text (with main-process re-transcription this
 *                          is the whole utterance) — accumulated and shown, arms a fallback timer.
 *   - utterance_end      → commit the accumulated turn as one message (onCommit).
 *
 * Commit is driven primarily by the main process's `utterance_end` event; the
 * fallback timer is only a safety net for a wedged-open VAD. Transcripts are
 * dropped while TTS is playing so Sulla never transcribes her own voice.
 */

export interface VoiceTurnAccumulatorConfig {
  /** Update the live interim display with the given text. */
  onInterim: (text: string) => void;
  /**
   * Commit the finished utterance. `text` may be empty (e.g. only silence / a blank
   * re-transcription) — the caller should always tear down its interim bubble and only
   * dispatch a message when `text` is non-empty.
   */
  onCommit: (text: string) => void;
  /** Whether Sulla's TTS is currently playing (used to drop self-transcription). */
  isTTSPlaying: () => boolean;
  /** Fallback commit delay (ms) if `utterance_end` never arrives. Defaults to 8000. */
  fallbackMs?: number;
  /** Silence grace after utterance_end; speech during this window joins this turn. */
  endOfTurnHoldMs?: number;
  endOfTurnDetector?: EndOfTurnDetector;
}

export interface VoiceTurnAccumulator {
  /** Feed a raw `gateway-transcript` payload (transcript_partial | transcript_turn | utterance_end). */
  handleEvent: (msg: any) => void;
  /** Commit whatever is accumulated right now (e.g. on stopRecording). */
  commitNow: () => void;
  /** Drop all accumulated state without committing (e.g. on startRecording). */
  reset: () => void;
  /** Cancel pending end-of-turn commit when VAD hears resumed speech. */
  speechStarted: () => void;
}

export function createVoiceTurnAccumulator(config: VoiceTurnAccumulatorConfig): VoiceTurnAccumulator {
  const fallbackMs = config.fallbackMs ?? 8000;
  const holdMs = config.endOfTurnHoldMs ?? 700;
  const detector = config.endOfTurnDetector ?? new HeuristicEndOfTurnDetector();

  // Authoritative text from transcript_turn events (one full-utterance transcript when
  // main-process re-transcription is on). `partial` is live-display only.
  const committedText = new TurnBuffer();
  let partialText = '';
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  }

  function commit(): void {
    clearTimer();
    const text = committedText.text;
    committedText.clear();
    partialText = '';
    config.onCommit(text);
  }

  function handleEvent(msg: any): void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (msg?.event_type === 'utterance_end') {
      clearTimer();
      fallbackTimer = setTimeout(commit, detector.delayMs(committedText.text, holdMs));
      return;
    }

    if (!msg?.text) return;

    // Don't transcribe Sulla's own TTS back into the next user message.
    if (config.isTTSPlaying()) return;

    const text = String(msg.text).trim();
    if (!text) return;

    // A resumed phrase during the grace period is still the same user turn.
    clearTimer();

    if (msg.event_type === 'transcript_partial') {
      // Live feedback only — accumulate for display, never commit a partial.
      partialText = partialText ? `${ partialText } ${ text }` : text;
      config.onInterim(committedText.text ? `${ committedText.text } ${ partialText }` : partialText);
    } else {
      // transcript_turn — authoritative text for the turn.
      committedText.append(text);
      partialText = '';
      config.onInterim(committedText.text);

      // Arm the long fallback only; the real commit comes from `utterance_end`.
      clearTimer();
      fallbackTimer = setTimeout(commit, fallbackMs);
    }
  }

  return {
    handleEvent,
    commitNow: commit,
    speechStarted() { clearTimer(); },
    reset() {
      clearTimer();
      committedText.clear();
      partialText = '';
    },
  };
}
