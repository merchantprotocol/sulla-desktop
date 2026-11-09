// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

import { SpeakerCaptureIntegrity } from '@pkg/pages/capture-studio/services/SpeakerCaptureIntegrity';

class TrackStub {
  readonly stop = vi.fn();
  constructor(public enabled: boolean, public readyState: MediaStreamTrackState) {}
}

describe('SpeakerCaptureIntegrity', () => {
  const integrity = new SpeakerCaptureIntegrity();

  it('accepts only enabled live native tracks', () => { // risk: false native success suppresses fallback
    const live = new TrackStub(true, 'live');
    expect(integrity.usableTracks([live, new TrackStub(true, 'ended'), new TrackStub(false, 'live')])).toEqual([live]);
  });

  it('does not publish a header-only speaker WAV', () => { // risk: corrupt capture manifest
    expect(integrity.shouldPublish({ type: 'system-audio', format: 'wav', bytes: 44 })).toBe(false);
    expect(integrity.shouldPublish({ type: 'system-audio', format: 'wav', bytes: 46 })).toBe(true);
  });

  it('accepts delivered PCM bytes without inspecting amplitude', () => { // risk: valid silence incorrectly rejected
    expect(integrity.shouldPublish({ type: 'system-audio', format: 'wav', bytes: 48 })).toBe(true);
  });
});
