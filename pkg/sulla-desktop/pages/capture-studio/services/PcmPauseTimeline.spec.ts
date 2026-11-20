// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { PcmPauseTimeline } from './PcmPauseTimeline';

describe('PcmPauseTimeline', () => {
  it('preserves paused duration as silence frames without extending repeated pauses', () => {
    // risk: recording timing — pause/resume must preserve elapsed audio timeline and ignore duplicate pause events.
    let now = 1000;
    const timeline = new PcmPauseTimeline(() => now);
    expect(timeline.pause()).toBe(true);
    expect(timeline.pause()).toBe(false);
    now += 1500;
    expect(timeline.resume(16000, 2)).toBe(48000);
    expect(timeline.resume(16000, 2)).toBe(0);
  });

  it('discards stale pause state across stop/start and clamps backwards clocks to zero silence', () => {
    // risk: recording integrity — stale wall-clock intervals must not create a giant/malformed PCM payload.
    let now = 3000;
    const timeline = new PcmPauseTimeline(() => now);
    timeline.pause();
    now = 2000;
    expect(timeline.resume(48000, 2)).toBe(0);
    timeline.pause();
    timeline.reset();
    now += 1000;
    expect(timeline.resume(48000, 2)).toBe(0);
  });
});
