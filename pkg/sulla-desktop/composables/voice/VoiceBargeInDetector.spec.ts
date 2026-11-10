// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TTSPlayerService } from './TTSPlayerService';
import { createVoiceBargeInDetector } from './VoiceBargeInDetector';

afterEach(() => vi.useRealTimers());
describe('voice barge-in', () => {
  it('risk: irreversible side effect — sustained speech stops playback and clears queued TTS', () => {
    vi.useFakeTimers(); let now = 0;
    const detector = createVoiceBargeInDetector({ now: () => now });
    const tts = new TTSPlayerService({ ipcInvoke: () => new Promise(() => {}) });
    tts.enqueue('first sentence'); tts.enqueue('second sentence');
    expect(tts.queueLength).toBeGreaterThan(0);
    expect(detector.update(true, true)).toBe(false);
    now += 400;
    if (detector.update(true, true)) tts.stop();
    expect(tts.queueLength).toBe(0);
  });
});
