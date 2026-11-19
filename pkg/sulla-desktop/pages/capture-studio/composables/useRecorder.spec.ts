// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { recordingFilename, toRecorderManifestStream } from './useRecorder';

describe('recordingFilename', () => {
  it('keeps the primary screen name and gives every extra screen a unique safe track filename', () => {
    // risk: data integrity — independent screen streams must not overwrite one another or disappear from the manifest.
    expect(recordingFilename('screen', 'screen')).toBe('screen.webm');
    expect(recordingFilename('screen', 'custom_2')).toBe('screen-custom_2.webm');
    expect(recordingFilename('screen', '../display:2')).toBe('screen-___display_2.webm');
    expect(recordingFilename('camera', 'cam')).toBe('camera.webm');
  });

  it('publishes each extra display as its own named manifest track', () => {
    // risk: data integrity — editors must be able to locate every independently recorded display.
    expect(toRecorderManifestStream({
      id: 'custom_2', type: 'screen', filename: recordingFilename('screen', 'custom_2'), startOffset: 12.6, bytesWritten: 512,
    })).toEqual({ id: 'custom_2', type: 'screen', filename: 'screen-custom_2.webm', format: 'webm', startOffset: 13, bytes: 512 });
  });
});
