// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SpeakerScorer } from '../inference/SpeakerScorer';

interface EnrollmentData { centroid: number[]; }

/** Persists only the normalized local speaker centroid, never audio or embeddings. */
export class SpeakerEnrollmentStore {
  private readonly path: string;
  constructor(userDataPath: string, private readonly scorer: SpeakerScorer) {
    this.path = `${userDataPath}/speaker-enrollment.json`;
  }
  async load(): Promise<number[] | null> {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as EnrollmentData;
      return this.scorer.normalize(data.centroid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async save(centroid: readonly number[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.part`;
    await writeFile(temp, JSON.stringify({ centroid: this.scorer.normalize(centroid) }), { mode: 0o600 });
    await rename(temp, this.path);
  }
}

/** Collects held-to-talk embeddings until the enrollment speech budget is reached. */
export class SpeakerEnrollment {
  private readonly samples: number[][] = [];
  private seconds = 0;
  constructor(private readonly store: SpeakerEnrollmentStore, private readonly scorer: SpeakerScorer, private readonly targetSeconds = 15) {}
  get collectedSeconds(): number { return this.seconds; }
  async add(embedding: readonly number[], speechSeconds: number): Promise<boolean> {
    if (speechSeconds < 1.5) return false;
    this.samples.push(this.scorer.normalize(embedding));
    this.seconds += speechSeconds;
    if (this.seconds < this.targetSeconds) return false;
    await this.store.save(this.scorer.centroid(this.samples));
    return true;
  }
}
