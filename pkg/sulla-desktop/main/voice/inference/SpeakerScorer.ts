// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type SpeakerDecision = 'match' | 'non-match' | 'no-centroid' | 'short-utterance';
export interface SpeakerScore { score: number | null; decision: SpeakerDecision; }

/** Pure speaker math and shadow threshold policy. */
export class SpeakerScorer {
  constructor(private readonly threshold = 0.70, private readonly minSpeechSeconds = 1.5) {}

  normalize(vector: readonly number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm === 0) throw new Error('Speaker embedding has zero or invalid norm');
    return vector.map(value => value / norm);
  }

  centroid(vectors: readonly (readonly number[])[]): number[] {
    if (vectors.length === 0) throw new Error('At least one embedding is required');
    const dimensions = vectors[0].length;
    if (vectors.some(vector => vector.length !== dimensions)) throw new Error('Speaker embeddings have inconsistent dimensions');
    const sum = Array.from({ length: dimensions }, (_, index) => vectors.reduce((total, vector) => total + vector[index], 0));
    return this.normalize(sum);
  }

  score(embedding: readonly number[], centroid: readonly number[] | null, speechSeconds: number): SpeakerScore {
    if (speechSeconds < this.minSpeechSeconds) return { score: null, decision: 'short-utterance' };
    if (!centroid) return { score: null, decision: 'no-centroid' };
    if (embedding.length !== centroid.length) throw new Error('Speaker embedding dimensions do not match centroid');
    const left = this.normalize(embedding);
    const right = this.normalize(centroid);
    const value = left.reduce((sum, item, index) => sum + item * right[index], 0);
    return { score: value, decision: value >= this.threshold ? 'match' : 'non-match' };
  }
}
