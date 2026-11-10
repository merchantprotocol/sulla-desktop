// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type {
  AudioChunk,
  SpeechToText,
  TextToSpeech,
  TranscriptEvent,
  VoiceLogger,
} from './VoiceEngines';

export interface StartTurnOptions {
  /** When true, the transcript of the turn being replaced is carried into the new turn. */
  mergePrevious: boolean;
}

/** Coordinates turn generations, cancellation and lossless transcript handoff independently of engines. */
export class VoiceEngineSession {
  private sequence = 0;
  private sttController: AbortController | null = null;
  private ttsController: AbortController | null = null;
  private transcript = '';

  constructor(
    private readonly stt: SpeechToText,
    private readonly tts: TextToSpeech,
    private readonly logger: VoiceLogger,
  ) {}

  /** Starts a new turn. Any in-flight turn is aborted; its text is kept only when `mergePrevious` is set. */
  startTurn(options: StartTurnOptions = { mergePrevious: false }): number {
    const previous = this.cancelTurn();
    this.transcript = options.mergePrevious ? previous : '';
    this.sequence += 1;
    return this.sequence;
  }

  acceptTranscript(event: TranscriptEvent): boolean {
    if (event.sequenceId !== this.sequence) {
      this.logger.debug('Dropped stale transcript', { sequenceId: event.sequenceId });
      return false;
    }
    if (event.kind === 'final' && event.text.trim()) {
      this.transcript = [this.transcript, event.text.trim()].filter(Boolean).join(' ');
    }
    return true;
  }

  async recognize(audio: AsyncIterable<Float32Array>): Promise<string> {
    const id = this.sequence;
    const controller = new AbortController();
    this.sttController?.abort();
    this.sttController = controller;
    const events = await this.stt.transcribe(audio, id, controller.signal);
    for (const event of events) {
      this.acceptTranscript(event);
    }
    return this.transcript;
  }

  async *speak(text: string, onAudio: (chunk: AudioChunk) => void): AsyncGenerator<AudioChunk> {
    const id = this.sequence;
    const controller = new AbortController();
    this.ttsController?.abort();
    this.ttsController = controller;
    for await (const chunk of this.tts.synthesize(text, id, controller.signal)) {
      if (controller.signal.aborted || id !== this.sequence) {
        continue;
      }
      onAudio(chunk);
      yield chunk;
    }
  }

  /**
   * Finishes the current turn normally. Returns its final text and clears it so the next turn starts empty.
   * Does not abort engine work: anything still running for this turn is left to finish.
   */
  commitTurn(): string {
    const text = this.transcript;
    this.transcript = '';
    return text;
  }

  /** Aborts engine work and returns the recognized text intact so the caller can merge it. */
  cancelTurn(): string {
    this.sttController?.abort();
    this.ttsController?.abort();
    this.sttController = null;
    this.ttsController = null;
    const text = this.transcript;
    this.transcript = '';
    return text;
  }

  get currentSequenceId(): number {
    return this.sequence;
  }
}
