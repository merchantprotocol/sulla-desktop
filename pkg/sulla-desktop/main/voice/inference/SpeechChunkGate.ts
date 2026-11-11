// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import { SileroChunkGate } from './SileroChunkGate';
import type { OrtResponse } from './OrtInferenceClient';

export interface SpeechGateClient {
  infer(request: { operation: 'vad-chunk'; modelPath: string; audio: Float32Array; state: Float32Array }, signal?: AbortSignal, timeoutMs?: number): Promise<OrtResponse>;
}

/** Fail-open Silero gate for complete 16 kHz, signed-16 PCM chunks. */
export class SpeechChunkGate {
  private readonly decisions = new SileroChunkGate(0.5, 0.2, 2);
  private readonly state = new Float32Array(256);
  private readonly context = new Float32Array(64);
  private modelPath: string | null;
  private previousRejected: Buffer | null = null;
  private warned = false;
  private counters = { seen: 0, admitted: 0, rejected: 0, failedOpen: 0, inferenceMs: 0 };
  private inferenceCount = 0;
  private lastStatsAt = 0;
  private gateState: 'cold' | 'warm' | 'disabled' = 'cold';

  constructor(
    private readonly client: SpeechGateClient,
    modelPath: string | null,
    private readonly exists: (path: string) => boolean = fs.existsSync,
    private readonly logWarning: (message: string) => void = message => console.warn(`[Voice][Silero] ${message}`),
    private readonly now: () => number = () => Date.now(),
    private readonly budgetMs = 400,
    private readonly logStats: (message: string, stats: Readonly<{ seen: number; admitted: number; rejected: number; failedOpen: number; meanInferenceMs: number }>) => void = () => undefined,
  ) { this.modelPath = modelPath; }

  setModelPath(modelPath: string): void { this.modelPath = modelPath; }

  /** Loads the ONNX session outside the per-chunk latency budget. */
  async warmModel(modelPath: string): Promise<void> {
    const started = this.now();
    if (!this.exists(modelPath)) throw new Error('Silero model is missing');
    const response = await this.client.infer({
      operation: 'vad-chunk',
      modelPath,
      audio: new Float32Array(576),
      state: new Float32Array(256),
    }, undefined, 10_000);
    if (!response.ok || !response.probabilities || !response.state) {
      throw new Error(response.error || 'Silero warm-up returned incomplete output');
    }
    this.reset();
    this.setModelPath(modelPath);
    this.gateState = 'warm';
    this.logStats(`Silero gate state: warm; model=${modelPath}; ms=${this.now() - started}`, this.snapshot());
  }

  takePreroll(): Buffer | null { const value = this.previousRejected; this.previousRejected = null; return value; }

  async shouldTranscribe(pcm: Buffer): Promise<boolean> {
    this.counters.seen++;
    if (!this.modelPath || !this.exists(this.modelPath)) return this.fallback('Silero model is missing');
    const probabilities: number[] = [];
    const started = this.now();
    const frameCount = Math.ceil(pcm.length / 1024);
    const nextState = new Float32Array(this.state);
    try {
      const audio = new Float32Array(64 + frameCount * 512);
      audio.set(this.context);
      for (let i = 0; i < frameCount * 512; i++) audio[64 + i] = i * 2 + 1 < pcm.length ? pcm.readInt16LE(i * 2) / 32768 : 0;
      const response = await this.client.infer({ operation: 'vad-chunk', modelPath: this.modelPath, audio, state: nextState }, undefined, this.budgetMs);
      if (!response.ok || !response.probabilities || !response.state) throw new Error(response.error || 'Silero returned incomplete output');
      probabilities.push(...response.probabilities);
      nextState.set(response.state);
      if (this.now() - started > this.budgetMs) return this.fallback('Silero chunk inference exceeded 400 ms');
      this.state.set(nextState);
      this.context.set(audio.subarray(audio.length - 64));
      const forward = this.decisions.shouldForward(probabilities);
      this.counters.inferenceMs += this.now() - started;
      this.inferenceCount++;
      if (forward) this.counters.admitted++; else this.counters.rejected++;
      this.reportStats();
      if (!forward) this.previousRejected = Buffer.from(pcm);
      return forward;
    } catch (error) {
      return this.fallback(`Silero unavailable: ${String(error)}`);
    }
  }

  reset(): void {
    this.state.fill(0);
    this.context.fill(0);
    this.previousRejected = null;
    this.decisions.reset();
  }

  private fallback(message: string): true {
    this.counters.failedOpen++;
    this.reset();
    if (this.gateState !== 'disabled') {
      this.gateState = 'disabled';
      this.logStats(`Silero gate state: disabled; ${message}`, this.snapshot());
    }
    if (!this.warned) {
      this.warned = true;
      this.logWarning(`${message}; passing audio through`);
    }
    return true;
  }

  private reportStats(): void {
    const now = this.now();
    if (now - this.lastStatsAt < 10_000) return;
    this.lastStatsAt = now;
    this.logStats('Silero gate stats', this.snapshot());
  }

  private snapshot() { return { ...this.counters, meanInferenceMs: this.inferenceCount ? this.counters.inferenceMs / this.inferenceCount : 0 }; }
}
