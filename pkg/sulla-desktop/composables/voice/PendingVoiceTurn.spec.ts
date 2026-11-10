// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { PendingVoiceTurn } from './PendingVoiceTurn';

describe('PendingVoiceTurn', () => {
  it('risk: data accuracy — merges only while prior reply remains pending', () => {
    const turn = new PendingVoiceTurn(); turn.submitted('first');
    expect(turn.mergeWithNext('follow up', true)).toBe('first follow up');
    expect(turn.mergeWithNext('later', false)).toBeNull();
  });
  it('risk: data accuracy — refuses merge once answer audio starts', () => {
    const turn = new PendingVoiceTurn(); turn.submitted('first'); turn.markAudioStarted();
    expect(turn.mergeWithNext('later', true)).toBeNull();
  });
});
