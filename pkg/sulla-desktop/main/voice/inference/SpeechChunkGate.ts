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

export type SpeechGateState = 'cold' | 'warm' | 'disabled';

export interface SpeechGateStats {
  chunksSeen: number;
  admitted: number;
  rejected: number;
  failedOpen: number;
  meanInferenceMs: number;
  consecutiveFailures: number;
  state: SpeechGateState;
}

/** Fail-open Silero gate for complete 16 kHz, signed-16 PCM chunks. */
export class SpeechChunkGate {
  private readonly decisions = new SileroChunkGate(0.5, 0.2, 2);
  private readonly state = new Float32Array(256);
  private readonly context = new Float32Array(64);
  private modelPath: string | null;
  private previousRejected: Buffer | null = null;
  private gateState: SpeechGateState = 'cold';
  private warmup: Promise<void> | null = null;
  private chunksSeen = 0;
  private admitted = 0;
  private rejected = 0;
  private failedOpen = 0;
  private inferenceCount = 0;
  private inferenceMs = 0;
  private consecutiveFailures = 0;

  constructor(
    private readonly client: SpeechGateClient,
    modelPath: string | null,
    private readonly exists: (path: string) => boolean = fs.existsSync,
    private readonly logWarning: (message: string) => void = message => console.warn(`[Voice][Silero] ${message}`),
    private readonly now: () => number = () => Date.now(),
    private readonly budgetMs = 400,
  ) { this.modelPath = modelPath; }

  setModelPath(modelPath: string): void {
    this.modelPath = modelPath;
    this.setState('cold', 'Silero model available; warming ONNX session');
    void this.warmModel(modelPath).catch(() => undefined);
  }

  /** Loads the ONNX session outside the per-chunk latency budget. */
  async warmModel(modelPath: string): Promise<void> {
    if (this.gateState === 'warm' && this.modelPath === modelPath) return;
    if (this.gateState === 'warm') this.setState('cold', 'new Silero model requires warm-up');
    this.modelPath = modelPath;
    if (this.warmup) return this.warmup;

    this.warmup = this.loadModelSession(modelPath)
      .then(() => {
        this.reset();
        this.consecutiveFailures = 0;
        this.setState('warm', 'Silero gate warmed and active');
      })
      .catch(error => {
        this.setState('disabled', `Silero warm-up failed: ${String(error)}; passing audio through`);
        throw error;
      })
      .finally(() => { this.warmup = null; });
    return this.warmup;
  }

  takePreroll(): Buffer | null { const value = this.previousRejected; this.previousRejected = null; return value; }

  async shouldTranscribe(pcm: Buffer): Promise<boolean> {
    this.chunksSeen++;
    if (!this.modelPath || !this.exists(this.modelPath)) {
      this.failedOpen++;
      this.setState('disabled', 'Silero model is missing; passing audio through');
      return true;
    }
    if (this.gateState !== 'warm') {
      this.failedOpen++;
      if (!this.warmup) void this.warmModel(this.modelPath).catch(() => undefined);
      return true;
    }

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
      const inferenceMs = this.now() - started;
      this.recordInference(inferenceMs);
      if (inferenceMs > this.budgetMs) {
        this.consecutiveFailures++;
        return this.failOpen();
      }
      this.state.set(nextState);
      this.context.set(audio.subarray(audio.length - 64));
      const forward = this.decisions.shouldForward(probabilities);
      this.consecutiveFailures = 0;
      if (!forward) {
        this.rejected++;
        this.previousRejected = Buffer.from(pcm);
      } else {
        this.admitted++;
        this.previousRejected = null;
      }
      return forward;
    } catch (error) {
      this.recordInference(this.now() - started);
      this.consecutiveFailures++;
      return this.failOpen();
    }
  }

  takeStats(): SpeechGateStats {
    const stats = {
      chunksSeen: this.chunksSeen,
      admitted: this.admitted,
      rejected: this.rejected,
      failedOpen: this.failedOpen,
      meanInferenceMs: this.inferenceCount ? Math.round(this.inferenceMs / this.inferenceCount) : 0,
      consecutiveFailures: this.consecutiveFailures,
      state: this.gateState,
    } satisfies SpeechGateStats;
    this.chunksSeen = 0;
    this.admitted = 0;
    this.rejected = 0;
    this.failedOpen = 0;
    this.inferenceCount = 0;
    this.inferenceMs = 0;
    return stats;
  }

  reset(): void {
    this.state.fill(0);
    this.context.fill(0);
    this.previousRejected = null;
    this.decisions.reset();
  }

  private async loadModelSession(modelPath: string): Promise<void> {
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
  }

  private failOpen(): true {
    this.failedOpen++;
    this.previousRejected = null;
    return true;
  }

  private recordInference(durationMs: number): void {
    this.inferenceCount++;
    this.inferenceMs += durationMs;
  }

  private setState(state: SpeechGateState, reason: string): void {
    if (this.gateState === state) return;
    const previous = this.gateState;
    this.gateState = state;
    this.logWarning(`Silero gate state changed ${previous} → ${state}: ${reason}`);
  }
}
