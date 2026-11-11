// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { SelfEchoFilter } from '../../../composables/voice/SelfEchoFilter';
import { VoiceAssignmentCache } from './VoiceAssignmentCache';

describe('VoiceAssignmentCache', () => {
  it('rejects speaker attribution during playback and accepts it after the echo tail', () => {
    // risk: voice identity attribution
    let now = 0;
    const echo = new SelfEchoFilter({ now: () => now, tailMs: 100 });
    const cache = new VoiceAssignmentCache(() => now, 60_000, 50, () => !echo.hasRecentSpeech());
    const assignment = { voiceId: 'speaker-1', voiceLabel: 'Owner', isOwner: true, score: 0.99 };

    echo.recordSpoken('Sulla is speaking now');
    echo.playbackStarted();
    cache.put('echo-turn', assignment);
    expect(cache.take('echo-turn')).toBeUndefined();

    echo.playbackEnded();
    now = 101;
    cache.put('user-turn', assignment);
    expect(cache.take('user-turn')).toEqual(assignment);
  });
});
