// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ModelRepository } from '../engine/ModelRepository';
import type { Logger } from '../../audio-driver/model/logger';
import type { SpeakerEmbeddingRunner } from './SpeakerEmbeddingRunner';
import { VoiceRegistry } from './VoiceRegistry';

export interface VoiceAssignment { turnId: string; voiceId: string; voiceLabel: string; isOwner: boolean; score: number; }
/** Computes local voice embeddings serially; failures never affect the speech path. */
export class VoiceIdentifier {
  readonly registry: VoiceRegistry;
  private queue: Promise<void> = Promise.resolve();
  private failed = false;
  constructor(private readonly models: ModelRepository, private readonly runner: SpeakerEmbeddingRunner, userDataPath: string,
    private readonly logger: Logger, private readonly onAssignment: (result: VoiceAssignment) => void = () => {},
    private readonly readEnabled: () => Promise<boolean> = async() => true) {
    this.registry = new VoiceRegistry(userDataPath);
  }
  private speechMs(pcm: Buffer): number {
    let frames = 0;
    for (let off = 0; off + 1 < pcm.length; off += 640) {
      const end = Math.min(pcm.length, off + 640); let sum = 0;
      for (let i = off; i < end; i += 2) { const n = pcm.readInt16LE(i); sum += n * n; }
      if (Math.sqrt(sum / ((end - off) / 2)) >= 330) frames++;
    }
    return frames * 20;
  }
  scoreTurn(pcm: Buffer, holdToTalk: boolean, turnId?: string): Promise<void> {
    const audio = Buffer.from(pcm.subarray(Math.max(0, pcm.length - 8 * 16_000 * 2)));
    this.queue = this.queue.then(() => this.process(audio, holdToTalk, turnId)).catch(error => {
      if (!this.failed) { this.failed = true; this.logger.warn('VoiceId', 'Voice identification unavailable; speech continues', { error: String(error) }); }
    });
    return this.queue;
  }
  private async process(pcm: Buffer, holdToTalk: boolean, turnId?: string): Promise<void> {
    const start = Date.now(); const speechMs = this.speechMs(pcm);
    if (speechMs < 1500 || !await this.readEnabled()) return;
    try {
      const model = await this.models.resolve('speaker-wespeaker-resnet34');
      const audio = new Float32Array(pcm.length / 2);
      for (let i = 0; i < audio.length; i++) audio[i] = pcm.readInt16LE(i * 2) / 32768;
      const embedding = await this.runner.run(model, audio);
      const result = await this.registry.assign(embedding, holdToTalk);
      const assignment = { turnId: turnId ?? '', voiceId: result.voice.id, voiceLabel: result.voice.name ? `${result.voice.label} — ${result.voice.name}` : result.voice.label,
        isOwner: result.voice.isOwner, score: result.score };
      this.logger.info('VoiceId', 'Voice turn identified', { turnId: assignment.turnId, voiceId: assignment.voiceId, score: assignment.score,
        isNew: result.isNew, isOwner: assignment.isOwner, speechMs, scoringMs: Date.now() - start });
      if (turnId) this.onAssignment(assignment);
    } catch (error) {
      if (!this.failed) { this.failed = true; this.logger.warn('VoiceId', 'Voice identification unavailable; speech continues', { error: String(error) }); }
    }
  }
}
