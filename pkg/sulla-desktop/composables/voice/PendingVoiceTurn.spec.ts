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

  it('risk: data accuracy — merges quick follow-up without losing either utterance', () => {
    const turn = new PendingVoiceTurn(); turn.submitted('first', false, 1_000);
    const merged = turn.mergeWithNext('follow up', true, 1_200);
    expect(merged).toBe('first follow up');
    turn.submitted(merged!, true);
    expect(turn.mergeWithNext('one more', true, 1_300)).toBe('first follow up one more');
  });

  it('risk: data accuracy — sends a follow-up separately outside the merge window', () => {
    const turn = new PendingVoiceTurn(); turn.submitted('first', false, 1_000);
    expect(turn.mergeWithNext('later', true, 9_001)).toBeNull();
  });

  it('risk: data accuracy — caps a pending turn at two merges', () => {
    const turn = new PendingVoiceTurn(); turn.submitted('first', false, 1_000);
    turn.submitted(turn.mergeWithNext('second', true, 1_100)!, true);
    turn.submitted(turn.mergeWithNext('third', true, 1_200)!, true);
    expect(turn.mergeWithNext('fourth', true, 1_300)).toBeNull();
  });

  it('risk: data accuracy — a fresh separate turn gets its own merge window and cap', () => {
    const turn = new PendingVoiceTurn(); turn.submitted('first', false, 1_000);
    expect(turn.mergeWithNext('later', true, 9_001)).toBeNull();
    turn.submitted('later', false, 9_001);
    expect(turn.mergeWithNext('quick follow up', true, 9_100)).toBe('later quick follow up');
  });

  it('risk: data accuracy — clears silent completed or aborted runs', () => {
    const turn = new PendingVoiceTurn(); turn.submitted('silent run');
    turn.clear(); // runState idle/paused/error watcher fires regardless of audioStarted
    expect(turn.mergeWithNext('next utterance', true)).toBeNull();
  });
});
