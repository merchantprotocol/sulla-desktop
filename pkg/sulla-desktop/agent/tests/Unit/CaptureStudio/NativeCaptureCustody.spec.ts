// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

import { NativeCaptureCustody } from '@pkg/pages/capture-studio/services/NativeCaptureCustody';
import { SpeakerCaptureIntegrity } from '@pkg/pages/capture-studio/services/SpeakerCaptureIntegrity';

class TrackStub {
  readonly stop = vi.fn();
}

class StreamStub {
  constructor(private readonly tracks: TrackStub[]) {}
  getTracks(): TrackStub[] { return this.tracks }
}

describe('NativeCaptureCustody', () => {
  it('rejects and stops a display stream resolved after release', () => { // risk: stale system-audio capture reactivates after stop
    const custody = new NativeCaptureCustody(new SpeakerCaptureIntegrity());
    const audio = new TrackStub();
    const video = new TrackStub();
    const request = custody.begin();

    custody.release();

    expect(custody.accept(request, new StreamStub([audio, video]) as any)).toBe(false);
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(video.stop).toHaveBeenCalledOnce();
  });

  it('accepts the current request without stopping its tracks', () => { // risk: valid native capture incorrectly falls back
    const custody = new NativeCaptureCustody(new SpeakerCaptureIntegrity());
    const audio = new TrackStub();
    const request = custody.begin();

    expect(custody.accept(request, new StreamStub([audio]) as any)).toBe(true);
    expect(audio.stop).not.toHaveBeenCalled();
  });
});
