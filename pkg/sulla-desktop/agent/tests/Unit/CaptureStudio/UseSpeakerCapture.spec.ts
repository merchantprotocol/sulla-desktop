// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vue', () => ({
  ref: <T>(value: T) => ({ value }),
  onUnmounted: vi.fn(),
}));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn() } }));

import { useSpeakerCapture } from '@pkg/pages/capture-studio/composables/useSpeakerCapture';
import { NativeCaptureCustody } from '@pkg/pages/capture-studio/services/NativeCaptureCustody';
import { SpeakerCaptureIntegrity } from '@pkg/pages/capture-studio/services/SpeakerCaptureIntegrity';

class TrackStub {
  readonly kind: 'audio' | 'video';
  readonly stop = vi.fn();
  readonly addEventListener = vi.fn();
  enabled = true;
  readyState = 'live';

  constructor(kind: 'audio' | 'video' = 'audio') { this.kind = kind }
}

class StreamStub {
  active = true;
  constructor(readonly tracks: TrackStub[]) {}
  getTracks(): TrackStub[] { return this.tracks }
  getAudioTracks(): TrackStub[] { return this.tracks.filter(track => track.kind === 'audio') }
  getVideoTracks(): TrackStub[] { return this.tracks.filter(track => track.kind === 'video') }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason: Error) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

describe('useSpeakerCapture native request lifecycle', () => {
  const integrity = new SpeakerCaptureIntegrity();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {});
    vi.stubGlobal('MediaStream', class extends StreamStub {});
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  it('does not publish a request cancelled during its post-acceptance yield', async() => { // risk: cancellation during readiness publishes stale capture
    const readiness = new Deferred<void>();
    const custody = new NativeCaptureCustody(integrity, () => readiness.promise);
    const audio = new TrackStub();
    const display = new StreamStub([audio, new TrackStub('video')]);
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(display) } });
    const capture = useSpeakerCapture(integrity, custody);

    const acquiring = capture.acquireNative();
    await vi.waitFor(() => expect(audio.addEventListener).toHaveBeenCalled());
    capture.releaseNative();
    readiness.resolve();

    await expect(acquiring).resolves.toBeNull();
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(capture.nativeStream.value).toBeNull();
    expect(capture.active.value).toBe(false);
    expect(capture.mode.value).toBe('none');
  });

  it('does not stop request B when older request A rejects after B succeeds', async() => { // risk: old rejection tears down current native capture
    const requestA = new Deferred<MediaStream>();
    const audioB = new TrackStub();
    const streamB = new StreamStub([audioB]);
    const getDisplayMedia = vi.fn()
      .mockReturnValueOnce(requestA.promise)
      .mockResolvedValueOnce(streamB);
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
    const capture = useSpeakerCapture(integrity);

    const acquiringA = capture.acquireNative();
    const acquiringB = capture.acquireNative();
    const acquiredB = await acquiringB;
    expect(acquiredB).toBe(capture.nativeStream.value);
    expect(capture.nativeStream.value?.getAudioTracks()).toEqual([audioB]);

    requestA.reject(new Error('request A failed'));
    await expect(acquiringA).resolves.toBeNull();

    expect(audioB.stop).not.toHaveBeenCalled();
    expect(capture.nativeStream.value?.getAudioTracks()).toEqual([audioB]);
    expect(capture.active.value).toBe(true);
    expect(capture.mode.value).toBe('native');
    capture.releaseNative();
  });
});
