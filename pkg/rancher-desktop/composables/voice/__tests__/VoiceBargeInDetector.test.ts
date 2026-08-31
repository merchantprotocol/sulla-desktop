import { describe, expect, it, jest } from '@jest/globals';

import { createVoiceBargeInDetector } from '../VoiceBargeInDetector';

describe('VoiceBargeInDetector', () => {
  it('interrupts only after sustained speech reaches the grace period', () => {
    let now = 1_000;
    const detector = createVoiceBargeInDetector({ now: () => now });

    expect(detector.update(true, true)).toBe(false);
    now += 399;
    expect(detector.update(true, true)).toBe(false);
    now += 1;
    expect(detector.update(true, true)).toBe(true);
  });

  it('ignores speech when playback is inactive', () => {
    let now = 1_000;
    const detector = createVoiceBargeInDetector({ now: () => now });

    expect(detector.update(true, false)).toBe(false);
    now += 1_000;
    expect(detector.update(true, false)).toBe(false);
    expect(detector.update(true, true)).toBe(false);
  });

  it('resets the grace period when speech stops', () => {
    let now = 1_000;
    const detector = createVoiceBargeInDetector({ now: () => now });

    expect(detector.update(true, true)).toBe(false);
    now += 300;
    expect(detector.update(false, true)).toBe(false);
    now += 300;
    expect(detector.update(true, true)).toBe(false);
    now += 399;
    expect(detector.update(true, true)).toBe(false);
    now += 1;
    expect(detector.update(true, true)).toBe(true);
  });

  it('supports an explicit reset between playback queues', () => {
    const now = jest.fn<() => number>()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_399)
      .mockReturnValueOnce(2_400);
    const detector = createVoiceBargeInDetector({ now });

    expect(detector.update(true, true)).toBe(false);
    detector.reset();
    expect(detector.update(true, true)).toBe(false);
    expect(detector.update(true, true)).toBe(false);
    expect(detector.update(true, true)).toBe(true);
  });
});
