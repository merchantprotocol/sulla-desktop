// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vue', () => ({
  ref: (value: unknown) => ({ value }),
  onUnmounted: vi.fn(),
}));
vi.mock('electron', () => ({ ipcRenderer: { invoke: vi.fn() } }));

import { useSpeakerCapture } from '@pkg/pages/capture-studio/composables/useSpeakerCapture';
import { SpeakerCaptureIntegrity } from '@pkg/pages/capture-studio/services/SpeakerCaptureIntegrity';

class TrackStub {
  readonly kind: 'audio' | 'video';
  readyState: MediaStreamTrackState = 'live';
  readonly stop = vi.fn(() => { this.readyState = 'ended' });
  readonly addEventListener = vi.fn();

  constructor(kind: 'audio' | 'video') {
    this.kind = kind;
  }
}

class MediaStreamStub {
  readonly tracks: TrackStub[];

  constructor(tracks: TrackStub[]) {
    this.tracks = tracks;
  }

  get active(): boolean { return this.tracks.some(track => track.readyState === 'live') }
  getTracks(): TrackStub[] { return this.tracks }
  getAudioTracks(): TrackStub[] { return this.tracks.filter(track => track.kind === 'audio') }
  getVideoTracks(): TrackStub[] { return this.tracks.filter(track => track.kind === 'video') }
}

describe('useSpeakerCapture native acquisition custody', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('MediaStream', MediaStreamStub);
  });

  it('stops a display stream that resolves after native capture was released', async() => { // risk: stale system-audio capture reactivates after stop
    let resolveDisplay!: (stream: MediaStreamStub) => void;
    const getDisplayMedia = vi.fn(() => new Promise<MediaStreamStub>(resolve => { resolveDisplay = resolve }));
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
    const capture = useSpeakerCapture(new SpeakerCaptureIntegrity());
    const audio = new TrackStub('audio');
    const video = new TrackStub('video');

    const pending = capture.acquireNative();
    capture.releaseNative();
    resolveDisplay(new MediaStreamStub([audio, video]));

    await expect(pending).resolves.toBeNull();
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(video.stop).toHaveBeenCalledOnce();
    expect(capture.nativeStream.value).toBeNull();
    expect(capture.active.value).toBe(false);
    expect(capture.mode.value).toBe('none');
  });
});
