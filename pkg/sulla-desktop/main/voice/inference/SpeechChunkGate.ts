// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import { SileroChunkGate } from './SileroChunkGate';
import type { OrtResponse } from './OrtInferenceClient';

export interface SpeechGateClient {
  infer(request: { operation: 'vad'; modelPath: string; audio: Float32Array; state: Float32Array }, signal?: AbortSignal, timeoutMs?: number): Promise<OrtResponse>;
}

/** Fail-open Silero gate for complete 16 kHz, signed-16 PCM chunks. */
export class SpeechChunkGate {
  private readonly decisions = new SileroChunkGate(0.5, 0.2, 2);
  private readonly context = new Float32Array(64);
  private readonly state = new Float32Array(256);
  private warned = false;

  constructor(
    private readonly client: SpeechGateClient,
    private readonly modelPath: string,
    private readonly exists: (path: string) => boolean = fs.existsSync,
    private readonly logWarning: (message: string) => void = message => console.warn(`[Voice][Silero] ${message}`),
    private readonly now: () => number = () => Date.now(),
    private readonly budgetMs = 300,
  ) {}

  async shouldTranscribe(pcm: Buffer): Promise<boolean> {
    if (!this.exists(this.modelPath)) return this.fallback('Silero model is missing');
    const probabilities: number[] = [];
    const started = this.now();
    const frameCount = Math.ceil(pcm.length / 1024);
    const nextContext = new Float32Array(this.context);
    const nextState = new Float32Array(this.state);
    try {
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        const frame = new Float32Array(512);
        for (let i = 0; i < frame.length; i++) {
          const offset = (frameIndex * 512 + i) * 2;
          frame[i] = offset + 1 < pcm.length ? pcm.readInt16LE(offset) / 32768 : 0;
        }
        const input = new Float32Array(576);
        input.set(nextContext);
        input.set(frame, 64);
        const response = await this.client.infer({ operation: 'vad', modelPath: this.modelPath, audio: input, state: nextState }, undefined, this.budgetMs);
        if (!response.ok || response.probability === undefined || !response.state) throw new Error(response.error || 'Silero returned incomplete output');
        probabilities.push(response.probability);
        nextState.set(response.state);
        nextContext.set(input.subarray(512));
        if (this.now() - started > this.budgetMs) return this.fallback('Silero chunk inference exceeded 300 ms');
      }
      this.context.set(nextContext);
      this.state.set(nextState);
      return this.decisions.shouldForward(probabilities);
    } catch (error) {
      return this.fallback(`Silero unavailable: ${String(error)}`);
    }
  }

  reset(): void {
    this.context.fill(0);
    this.state.fill(0);
    this.decisions.reset();
  }

  private fallback(message: string): true {
    this.reset();
    if (!this.warned) {
      this.warned = true;
      this.logWarning(`${message}; passing audio through`);
    }
    return true;
  }
}
