// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoiceTurnAccumulator } from './VoiceTurnAccumulator';

afterEach(() => vi.useRealTimers());
describe('VoiceTurnAccumulator', () => {
  it('risk: data accuracy — buffered words commit on fallback after speech-start without another transcript', () => {
    vi.useFakeTimers(); const onCommit = vi.fn();
    const turn = createVoiceTurnAccumulator({ onInterim: () => {}, onCommit, isTTSPlaying: () => false, fallbackMs: 8000 });
    turn.handleEvent({ event_type: 'transcript_turn', text: 'keep these words' });
    turn.speechStarted(); vi.advanceTimersByTime(7999); expect(onCommit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(onCommit).toHaveBeenCalledWith('keep these words');
  });
});
