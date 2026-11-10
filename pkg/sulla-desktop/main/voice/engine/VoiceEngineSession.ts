// SPDX-License-Identifier: GPL-2.0-or-later
import type { AudioChunk, SpeechToText, TextToSpeech, TranscriptEvent, VoiceLogger } from './VoiceEngines';
/** Coordinates turn generations, cancellation and lossless transcript handoff independently of engines. */
export class VoiceEngineSession {
  private sequence = 0;
  private sttController: AbortController | null = null;
  private ttsController: AbortController | null = null;
  private transcript = '';
  constructor(private readonly stt: SpeechToText, private readonly tts: TextToSpeech, private readonly logger: VoiceLogger) {}
  startTurn(): number {
    const preserved = this.cancelTurn();
    this.transcript = preserved;
    this.sequence += 1;
    return this.sequence;
  }
  acceptTranscript(event: TranscriptEvent): boolean {
    if (event.sequenceId !== this.sequence) { this.logger.debug('Dropped stale transcript', { sequenceId: event.sequenceId }); return false; }
    if (event.kind === 'final' && event.text.trim()) this.transcript = [this.transcript, event.text.trim()].filter(Boolean).join(' ');
    return true;
  }
  async recognize(audio: AsyncIterable<Float32Array>): Promise<string> {
    const id = this.sequence; const controller = new AbortController(); this.sttController?.abort(); this.sttController = controller;
    const events = await this.stt.transcribe(audio, id, controller.signal);
    for (const event of events) this.acceptTranscript(event);
    return this.transcript;
  }
  async *speak(text: string, onAudio: (chunk: AudioChunk) => void): AsyncGenerator<AudioChunk> {
    const id = this.sequence; const controller = new AbortController(); this.ttsController?.abort(); this.ttsController = controller;
    for await (const chunk of this.tts.synthesize(text, id, controller.signal)) {
      if (controller.signal.aborted || id !== this.sequence) continue;
      onAudio(chunk); yield chunk;
    }
  }
  /** Aborts engine work and returns all recognized text for caller-side merge. */
  cancelTurn(): string {
    this.sttController?.abort(); this.ttsController?.abort(); this.sttController = null; this.ttsController = null;
    const text = this.transcript; this.transcript = ''; return text;
  }
  get currentSequenceId(): number { return this.sequence; }
}
