// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface SpeakerTrackLike {
  enabled: boolean;
  readyState: MediaStreamTrackState;
  stop(): void;
}

export interface RecordedStreamLike {
  type: string;
  format: string;
  bytes: number;
}

/** Applies readiness rules without using audio amplitude as a health signal. */
export class SpeakerCaptureIntegrity {
  static readonly WAV_HEADER_BYTES = 44;

  usableTracks<T extends SpeakerTrackLike>(tracks: T[]): T[] {
    return tracks.filter(track => track.enabled && track.readyState === 'live');
  }

  stopTracks(tracks: SpeakerTrackLike[]): void {
    for (const track of tracks) track.stop();
  }

  shouldPublish(stream: RecordedStreamLike): boolean {
    if (stream.type !== 'system-audio' || stream.format !== 'wav') return true;
    return stream.bytes > SpeakerCaptureIntegrity.WAV_HEADER_BYTES;
  }
}
