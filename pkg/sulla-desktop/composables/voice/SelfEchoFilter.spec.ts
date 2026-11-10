// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { SelfEchoFilter } from './SelfEchoFilter';
import { createVoiceTurnAccumulator } from './VoiceTurnAccumulator';

describe('SelfEchoFilter', () => {
  it("treats Sulla's own recently spoken words as echo and the user's words as speech", () => {
    let t = 0; const f = new SelfEchoFilter({ now: () => t });
    f.recordSpoken('I got that, so voice is sending now. The install worked.');
    expect(f.isEcho('voice is sending now the install')).toBe(true);
    expect(f.isEcho('stop and check my calendar')).toBe(false);
  });

  it('forgets spoken text after playback plus the tail', () => {
    let t = 0; const f = new SelfEchoFilter({ now: () => t, tailMs: 1000, secondsPerWord: 0.5 });
    f.recordSpoken('the install worked');
    t = 1000 + 3 * 500 + 1; // 3 words of playback + tail
    expect(f.isEcho('the install worked')).toBe(false);
  });

  it('echo picked up by the mic never becomes a user turn', () => {
    vi.useFakeTimers();
    try {
      const echo = new SelfEchoFilter({ now: () => Date.now() });
      const onCommit = vi.fn();
      const turn = createVoiceTurnAccumulator({
        onInterim: () => {}, onCommit, isTTSPlaying: () => false, isEcho: t => echo.isEcho(t), now: () => Date.now(),
      });
      echo.recordSpoken('Here is your schedule for today.');
      turn.handleEvent({ event_type: 'transcript_turn', text: 'here is your schedule for today' });
      turn.handleEvent({ event_type: 'utterance_end' });
      vi.advanceTimersByTime(5000);
      expect(onCommit).not.toHaveBeenCalled();
      turn.handleEvent({ event_type: 'transcript_turn', text: 'move my three o clock meeting' });
      vi.advanceTimersByTime(1500);
      expect(onCommit).toHaveBeenCalledWith('move my three o clock meeting');
    } finally { vi.useRealTimers(); }
  });
});
