/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import { createSpeakerTurnSegmenter } from '../audio-driver/model/speaker-turns';
import { createSpeakerVad, type SpeakerLevel } from '../audio-driver/model/speaker-vad';

// One capture-helper callback: 512 frames @48kHz ≈ 10.7ms → 170 samples @16kHz.
const FRAME_MS = 10;
const PCM_BYTES = 340;

const quiet: SpeakerLevel = { rms: 0.004, peak: 0.006, zcr: 0.2, variance: 0.000001, pitch: null, steadyPitch: false, centroid: 0 };
const voice: SpeakerLevel = { rms: 0.2, peak: 0.6, zcr: 0.15, variance: 0.001, pitch: 180, steadyPitch: false, centroid: 0.1 };
// Real speech dips between syllables/words, which keeps the adaptive floor low.
const dip: SpeakerLevel = { rms: 0.008, peak: 0.02, zcr: 0.2, variance: 0.0005, pitch: null, steadyPitch: false, centroid: 0.05 };
const speech = (i: number) => (i % 10 < 8 ? voice : dip);
// Hold tone: loud, flat, steady pitch, low ZCR — only the crest factor looks speech-like.
const tone: SpeakerLevel = { rms: 0.3, peak: 0.42, zcr: 0.018, variance: 0.00001, pitch: 440, steadyPitch: true, centroid: 0.01 };

type Source = SpeakerLevel | ((i: number) => SpeakerLevel);

function run(seg: ReturnType<typeof createSpeakerTurnSegmenter>, source: Source, ms: number, clock: { now: number }, fill = 1) {
  for (let t = 0, i = 0; t < ms; t += FRAME_MS, i++) {
    clock.now += FRAME_MS;
    seg.onLevel(typeof source === 'function' ? source(i) : source, clock.now);
    seg.onPcm(Buffer.alloc(PCM_BYTES, fill), clock.now);
  }
}

describe('speaker VAD', () => {
  it('confirms speech above the floor and rejects a steady tone', () => {
    const vad = createSpeakerVad();

    for (let i = 0; i < 50; i++) vad.process(quiet);
    expect(vad.getState().speaking).toBe(false);
    for (let i = 0; i < 5; i++) vad.process(voice);
    expect(vad.getState().speaking).toBe(true);

    vad.reset();
    for (let i = 0; i < 50; i++) vad.process(quiet);
    for (let i = 0; i < 200; i++) vad.process(tone);
    expect(vad.getState().speaking).toBe(false);
  });
});

describe('speaker turn segmenter', () => {
  it('emits nothing for silence or a hold tone', () => {
    const clock = { now: 1000 };
    const seg = createSpeakerTurnSegmenter();

    run(seg, quiet, 3000, clock);
    run(seg, tone, 3000, clock);
    seg.tick(clock.now);
    expect(seg.pendingCount()).toBe(0);
  });

  it('cuts one segment per speech turn, with pre-roll and hangover', () => {
    const clock = { now: 1000 };
    const seg = createSpeakerTurnSegmenter({ preRollMs: 300, turnEndMs: 700 });

    run(seg, quiet, 1000, clock, 0);
    run(seg, speech, 1500, clock, 1);
    expect(seg.pendingCount()).toBe(0); // still talking
    run(seg, quiet, 1500, clock, 0);
    expect(seg.pendingCount()).toBe(1);

    const pcm = seg.takeSegment() as Buffer;
    const bytesPerMs = 32;

    // Pre-roll (≤300ms) + ~1.5s speech + VAD hold + 700ms turn-end window.
    expect(pcm.length).toBeGreaterThan(1500 * bytesPerMs);
    expect(pcm.length).toBeLessThan(3000 * bytesPerMs);
    expect(pcm[0]).toBe(0); // starts in the pre-roll, before the first voiced frame
    expect(pcm.length % 2).toBe(0);

    // A second turn is its own segment.
    run(seg, speech, 800, clock, 1);
    run(seg, quiet, 1500, clock, 0);
    expect(seg.pendingCount()).toBe(1);
  });

  it('keeps a short pause inside one turn', () => {
    const clock = { now: 1000 };
    const seg = createSpeakerTurnSegmenter({ turnEndMs: 700 });

    run(seg, quiet, 500, clock);
    run(seg, speech, 800, clock);
    run(seg, quiet, 300, clock);
    run(seg, speech, 800, clock);
    run(seg, quiet, 1500, clock);
    expect(seg.pendingCount()).toBe(1);
  });

  it('cuts long turns at maxSegmentMs', () => {
    const clock = { now: 1000 };
    const seg = createSpeakerTurnSegmenter({ maxSegmentMs: 2000 });

    run(seg, quiet, 500, clock);
    run(seg, speech, 5000, clock);
    expect(seg.pendingCount()).toBe(2);
  });

  it('falls back to ungated fixed slices when no level frames arrive', () => {
    const seg = createSpeakerTurnSegmenter({ fallbackSliceMs: 2000 });
    let now = 1000;

    for (let i = 0; i < 100; i++) {
      now += FRAME_MS;
      seg.onPcm(Buffer.alloc(PCM_BYTES, 1), now);
    }
    seg.tick(now);
    expect(seg.pendingCount()).toBe(1);
    expect(seg.takeSegment()?.length).toBe(100 * PCM_BYTES);
  });

  it('closes an open turn when level frames stop', () => {
    const clock = { now: 1000 };
    const seg = createSpeakerTurnSegmenter();

    run(seg, quiet, 500, clock);
    run(seg, speech, 800, clock);
    seg.tick(clock.now + 5000);
    expect(seg.pendingCount()).toBe(1);
  });

  it('keeps 16-bit alignment across odd-length pipe reads', () => {
    const seg = createSpeakerTurnSegmenter();
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

    seg.onPcm(bytes.subarray(0, 3), 1000);
    seg.onPcm(bytes.subarray(3, 8), 1000);
    seg.tick(10_000);
    expect(seg.takeSegment()).toEqual(bytes);
  });
});
