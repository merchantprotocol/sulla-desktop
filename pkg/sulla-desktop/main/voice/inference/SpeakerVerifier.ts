// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import type { ModelRepository } from '../engine/ModelRepository';
import { SpeakerEnrollment, SpeakerEnrollmentStore } from '../engine/SpeakerEnrollmentStore';
import type { Logger } from '../../audio-driver/model/logger';
import { SpeakerScorer } from './SpeakerScorer';
import type { SpeakerEmbeddingRunner } from './SpeakerEmbeddingRunner';

/** Asynchronous, fail-open observer for committed voice turns. */
export class SpeakerVerifier {
  private readonly scorer = new SpeakerScorer();
  private readonly enrollment: SpeakerEnrollment;
  private readonly store: SpeakerEnrollmentStore;
  private centroid: number[] | null = null;
  private loaded = false;
  private failureLogged = false;
  constructor(private readonly models: ModelRepository, private readonly runner: SpeakerEmbeddingRunner, userDataPath: string, private readonly logger: Logger) {
    this.store = new SpeakerEnrollmentStore(userDataPath, this.scorer);
    this.enrollment = new SpeakerEnrollment(this.store, this.scorer);
  }
  async scoreTurn(pcm: Buffer, manualTurn: boolean): Promise<void> {
    const start = Date.now();
    const speechMs = Math.floor(pcm.length / 32);
    if (speechMs < 1_500) return;
    try {
      const modelPath = await this.models.resolve('speaker-wespeaker-resnet34');
      const audio = new Float32Array(pcm.length / 2);
      for (let index = 0; index < audio.length; index++) audio[index] = pcm.readInt16LE(index * 2) / 32768;
      const embedding = await this.runner.run(modelPath, audio);
      if (!this.loaded) { this.centroid = await this.store.load(); this.loaded = true; }
      if (!this.centroid) {
        if (manualTurn) {
          const complete = await this.enrollment.add(embedding, speechMs / 1000);
          this.logger.info('SpeakerVerifier', 'Enrollment progress', { secondsCollected: Math.min(this.enrollment.collectedSeconds, 15), targetSeconds: 15 });
          if (complete) this.centroid = await this.store.load();
        }
        return;
      }
      const result = this.scorer.score(embedding, this.centroid, speechMs / 1000);
      this.logger.info('SpeakerVerifier', 'Shadow speaker score', { turnId: randomUUID(), score: result.score, decision: result.decision, speechMs, scoringMs: Date.now() - start });
    } catch (error) {
      if (!this.failureLogged) {
        this.failureLogged = true;
        this.logger.warn('SpeakerVerifier', 'Speaker scoring unavailable; continuing voice turn without score', { error: String(error) });
      }
    }
  }
}
