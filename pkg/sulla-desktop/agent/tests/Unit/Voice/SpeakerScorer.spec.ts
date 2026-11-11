// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import { SpeakerScorer } from '@pkg/main/voice/inference/SpeakerScorer';
import { SpeakerVerifier } from '@pkg/main/voice/inference/SpeakerVerifier';

describe('SpeakerScorer', () => {
  const scorer = new SpeakerScorer();
  // risk: identity data accuracy
  it('normalizes vectors and the averaged centroid', () => {
    expect(scorer.normalize([3, 4])).toEqual([0.6, 0.8]);
    expect(scorer.centroid([[1, 0], [0, 1]])).toEqual([Math.SQRT1_2, Math.SQRT1_2]);
  });
  // risk: incorrect shadow classification
  it('applies the calibration threshold to cosine similarity', () => {
    expect(scorer.score([1, 0], [1, 0], 1.5)).toEqual({ score: 1, decision: 'match' });
    expect(scorer.score([0, 1], [1, 0], 1.5)).toEqual({ score: 0, decision: 'non-match' });
  });
  // risk: misleading identity decision for insufficient speech
  it('does not score speech shorter than 1.5 seconds', () => {
    expect(scorer.score([1, 0], [1, 0], 1.499)).toEqual({ score: null, decision: 'short-utterance' });
  });
  // risk: identity data accuracy before local enrollment
  it('does not score before enrollment', () => {
    expect(scorer.score([1, 0], null, 2)).toEqual({ score: null, decision: 'no-centroid' });
  });
  // risk: malformed model output
  it('guards incompatible/invalid embeddings', () => {
    expect(() => scorer.normalize([0, 0])).toThrow();
    expect(() => scorer.score([1], [1, 0], 2)).toThrow();
  });
  // risk: ambient noise must not inflate the speech-duration threshold
  it('ignores low-level room noise when measuring voiced duration', async() => {
    const resolve = vi.fn();
    const runner = { run: vi.fn() };
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), getLogDir: () => '', getLogPath: () => '' };
    const verifier = new SpeakerVerifier({ resolve } as any, runner as any, '/tmp/speaker-noise-test', logger as any);
    const pcm = Buffer.alloc(16_000 * 2 * 3);
    for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(100, offset);
    await verifier.scoreTurn(pcm, false);
    expect(resolve).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  // risk: availability of voice transcription when the speaker model is missing
  it('fails open and logs only once when the model cannot load', async() => {
    const warn = vi.fn();
    const models = { resolve: vi.fn().mockRejectedValue(new Error('missing')) };
    const runner = { run: vi.fn() };
    const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(), getLogDir: () => '', getLogPath: () => '' };
    const verifier = new SpeakerVerifier(models as any, runner as any, '/tmp/speaker-test', logger as any);
    const pcm = Buffer.alloc(16_000 * 2 * 2);
    for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(1_000, offset);
    await verifier.scoreTurn(pcm, false);
    await verifier.scoreTurn(pcm, false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(runner.run).not.toHaveBeenCalled();
  });
});
